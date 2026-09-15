import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prisma } from './db';
import { meRoutes } from './routes/me';
import { receiptRoutes } from './routes/receipts';
import { inboxQuickRoutes, inboxRoutes } from './routes/inbox';
import { shareTargetRoutes } from './routes/share_target';
import { bundleRoutes } from './routes/bundles';
import { vendorRoutes } from './routes/vendors';
import { authCfRoutes, hasValidCfIdentity } from './routes/auth_cf';
import { authCardRoutes } from './routes/auth_card';
import { adminRoutes } from './routes/admin';
import { startKbizPoller } from './kbiz-poller';
import { ledgerFeedRoutes } from './routes/ledger-feed';

const PORT = Number(process.env.API_PORT ?? 3001);
const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

// Strict allowlist of characters in a filename — defends against `..`,
// absolute paths, percent-encoding, etc. Files written by saveUploadedFile
// only ever use [a-zA-Z0-9._-], so this is a tight match.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/**
 * Thumbnail widths the API will generate, as an allowlist.
 *
 *   96  — the 32–40px receipt thumbs in list rows, at 2–3x device pixel ratio
 *   320 — receipt cards and the photo gallery grid
 *   800 — a phone-sized full view; the lightbox still asks for the original
 *
 * Free-form widths would let anyone fill the uploads volume with variants, so
 * anything not on this list serves the original.
 */
const THUMB_WIDTHS = [96, 320, 800];
const THUMBS_DIR = resolve(UPLOADS_DIR, '.thumbs');

/**
 * Return a cached thumbnail, generating it on first request.
 *
 * Uses ImageMagick rather than a native module: the API runs on oven/bun:slim,
 * and shelling out to `convert` keeps a native binding out of the multi-stage
 * Docker build. Generation happens once per (image, width); every later request
 * is a plain file read.
 *
 * Returns null on any failure so the caller can serve the original — a receipt
 * photo that loads slowly is a performance problem, one that 500s is a broken
 * expense claim.
 */
async function thumbnailFor(
  sourcePath: string,
  filename: string,
  width: number,
): Promise<ReturnType<typeof Bun.file> | null> {
  const dir = resolve(THUMBS_DIR, `w${width}`);
  const out = resolve(dir, `${filename}.webp`);

  const cached = Bun.file(out);
  if (await cached.exists()) return cached;

  try {
    await mkdir(dir, { recursive: true });
    const proc = Bun.spawn(
      [
        'convert',
        sourcePath,
        // Honour EXIF rotation before resizing, or phone photos come out sideways.
        '-auto-orient',
        '-resize',
        `${width}x>`,
        '-quality',
        '78',
        '-strip',
        out,
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`[thumbs] convert failed (${code}) for ${filename} @ ${width}`);
      return null;
    }
    const made = Bun.file(out);
    return (await made.exists()) ? made : null;
  } catch (error) {
    console.error(`[thumbs] ${filename} @ ${width}:`, error);
    return null;
  }
}

// In production, only the web origin may make credentialed cross-origin calls.
// (The web app is same-origin behind nginx, so this is defense-in-depth.) If
// WEB_BASE_URL is unset in prod we fail closed to no cross-origin access.
const CORS_ORIGIN =
  process.env.NODE_ENV === 'production' ? (process.env.WEB_BASE_URL ?? false) : true;

const app = new Elysia()
  .use(cors({ origin: CORS_ORIGIN, credentials: true }))
  // Serve receipt photos and transfer-slip images from the uploads volume.
  // We hand-roll this instead of @elysiajs/static — that plugin enumerates
  // the directory once at boot and breaks on files added later (e.g. the
  // notion-import backfill, future receipt uploads).
  .get('/uploads/:filename', async ({ params, query, headers, set, status }) => {
    if (!SAFE_FILENAME.test(params.filename)) {
      return status(404, 'Not found');
    }

    // Receipt photos and bank-transfer slips. Until now the only thing in front
    // of them was the Cloudflare Access wall on the hostname: the route itself
    // checked nothing, so any leaked URL was the file. Filenames are a 16-hex
    // hash, but they travel in browser history, referrers, proxy logs and
    // shared links.
    //
    // Verifying the Access assertion here makes the origin enforce what the
    // edge does, so a URL that escapes is useless without a session. 404 rather
    // than 401 — an unauthenticated caller learns nothing about what exists.
    if (!(await hasValidCfIdentity(headers['cf-access-jwt-assertion']))) {
      return status(404, 'Not found');
    }
    const path = resolve(UPLOADS_DIR, params.filename);
    const file = Bun.file(path);
    if (!(await file.exists())) return status(404, 'Not found');

    // ?w=<width> serves a cached thumbnail instead of the original.
    //
    // These are camera photos: 1,545 of them totalling 339 MB, the largest
    // approaching 4 MB each. Every list that shows a 32px receipt thumb was
    // downloading and decoding the full-resolution original, which is the
    // single most expensive thing this app does on a phone.
    //
    // Widths are an allowlist, not free-form, so nobody can fill the disk by
    // requesting ?w=1,2,3… The variant is generated on first request and kept,
    // so the cost is paid once per image per size and never again.
    const requested = Number(query.w);
    if (THUMB_WIDTHS.includes(requested)) {
      const thumb = await thumbnailFor(path, params.filename, requested);
      if (thumb) {
        set.headers['cache-control'] = 'public, max-age=31536000, immutable';
        return thumb;
      }
      // Generation failed — fall through to the original rather than 500.
      // A slow image beats a broken one.
    }

    set.headers['cache-control'] = 'public, max-age=86400, immutable';
    return file;
  })
  .get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  })
  .get('/', () => ({ name: 'reimbursement-api', version: '0.1.0' }))
  .group('/api', (api) =>
    api
      .use(meRoutes)
      .use(ledgerFeedRoutes)
      .use(receiptRoutes)
      .use(inboxRoutes)
      // The two phone-facing producers carry their OWN authentication —
      // a share token and a Cloudflare Access assertion respectively — so
      // neither mounts the session `auth` plugin. Keeping them as separate
      // instances is what stops a future `.use(auth)` on a sibling from
      // silently making them require a session that a phone cannot have.
      .use(inboxQuickRoutes)
      .use(shareTargetRoutes)
      .use(bundleRoutes)
      .use(vendorRoutes)
      .use(authCfRoutes)
      .use(authCardRoutes)
      .use(adminRoutes),
  )
  .listen(PORT);

console.log(`API listening on http://localhost:${PORT}`);

// Reconcile finished KBIZ payments out of the shared queue directory. Starts
// only when that directory is actually mounted, so a dev machine (and any host
// without the mount) runs exactly as before. Not awaited: the server is already
// listening, and a queue that cannot be read must never delay /health.
void startKbizPoller();

export type App = typeof app;
