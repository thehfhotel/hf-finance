/**
 * The K BIZ QR-login handoff, as a PURE state machine.
 *
 * Since June 2026 K BIZ requires a scan from the K BIZ phone app after
 * user/pass on EVERY web login (live-verified 2026-09-17): after `#loginBtn`
 * the bank redirects to `/authen/loginQR.do?cmd=…`, renders `img.qrcode` (a
 * 150×150 `data:image/png` data URI) under "กรุณาทำรายการภายใน 05:55 นาที",
 * and redirects ITSELF to `/menu/account/account-summary` once the app
 * confirms. Unattended re-login is impossible by bank policy — a human must
 * scan — so the bot publishes the QR and asks for one.
 *
 * Same split as approval-wait.ts, for the same reason: root CI runs `bun test`
 * BEFORE kbiz-bot's node_modules exist, so this file (and everything under
 * test/) must never import "playwright", not even `import type`. The page,
 * the disk and Slack are reached only through the `QrLoginView` thunks;
 * `now`/`sleep` are thunks too, so the full 6.5-min deadline runs in
 * microseconds under a virtual clock (test/support/stub-qr-view.ts).
 *
 * This module decides NOTHING about money. It never resubmits credentials and
 * it never taps anything — the phone stays the gate, here as everywhere else.
 */

/** The URL the bank parks on while it waits for the scan. */
export const isQrLoginUrl = (url: string) => /loginQR\.do/i.test(url);

/** Still inside the unauthenticated login funnel (credentials OR QR page). */
const isAuthenUrl = (url: string) => /\/authen\//.test(url);

/** The page every logged-in check lands on. Shared so qr-login.ts's
 *  `confirmDashboard` and session.ts's `ensureLoggedIn` cannot drift apart —
 *  and kept HERE (pure) rather than in session.ts so the driver can import it
 *  without a session.ts ↔ qr-login.ts import cycle. */
export const KBIZ_DASHBOARD_URL = "https://kbiz.kasikornbank.com/menu/account/account-summary";

/** Where the operator opens the published QR. Contract default. */
export const DEFAULT_QR_PAGE_URL = "https://payroll.thehfhotel.org/kbiz/login-qr";

/**
 * How long the handoff waits for a scan. Deliberately the same 6.5 min the
 * phone-approval wait uses (approval-wait.ts APPROVAL_TIMEOUT_MS): the bank
 * gives the scan 5:55 and then rotates the QR, so 6.5 min strictly outlives
 * one full window plus a rotation.
 */
export const QR_HANDOFF_TIMEOUT_MS = 6.5 * 60_000;
/** Poll cadence. The page changes only when a human acts, so 2 s is plenty. */
export const QR_POLL_MS = 2_000;
/** The bank's own countdown: "กรุณาทำรายการภายใน 05:55 นาที". */
export const QR_WINDOW_MS = 5 * 60_000 + 55_000;
/** A rotated QR re-pings Slack at most this often. */
export const QR_NOTIFY_INTERVAL_MS = 60_000;
/** After a failed handoff, the batch is skipped for this long. */
export const QR_COOLDOWN_MS = 10 * 60_000;

/**
 * The bank is sitting on `loginQR.do` and this caller is not allowed to ask a
 * human to scan (the default `onQr: "refuse"` policy). Thrown INSTEAD of the
 * old 60 s `waitForURL` timeout, so a read-only caller — the payroll
 * settlement check, a scrape — gives up at once and files its own
 * "unavailable" outcome rather than stalling the queue loop for a minute.
 */
export class QrLoginRequiredError extends Error {
  constructor(message = "K BIZ wants a QR scan to log in (onQr: refuse)") {
    super(message);
    this.name = "QrLoginRequiredError";
  }
}

/**
 * The handoff ran and nobody scanned in time (or the bank bounced back to the
 * credentials form). The work is untouched and still queued; the caller backs
 * off for QR_COOLDOWN_MS before asking again.
 */
export class QrLoginTimeoutError extends Error {
  constructor(message = "nobody scanned the K BIZ QR in time") {
    super(message);
    this.name = "QrLoginTimeoutError";
  }
}

export type QrLoginStatus = "waiting" | "ok" | "expired" | "error";

/** The published `state.json`. payroll-form synthesizes `{status:"idle"}`
 *  when the file is missing — "idle" is deliberately NOT a status the bot
 *  can write. */
export interface QrLoginState {
  status: QrLoginStatus;
  /** Why a login was needed, e.g. "2 approved item(s)". */
  reason: string;
  /** 1-based; increments for each FRESH QR the bank shows in one handoff. */
  attempt: number;
  capturedAt: string | null;
  /** capturedAt + QR_WINDOW_MS. */
  expiresAt: string | null;
  updatedAt: string;
  /** Short human text. Masked — never an account number, never a query string. */
  message: string;
}

/**
 * The seam. qr-login.ts implements it over a Playwright Page + the filesystem
 * + the Slack webhook; test/support/stub-qr-view.ts implements it over a
 * virtual clock and arrays.
 */
export interface QrLoginView {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The page's current URL. */
  url(): string;
  /** `img.qrcode`'s `src` attribute, or null when no QR is rendered. Read as
   *  an ATTRIBUTE, never from a screenshot. */
  qrDataUri(): Promise<string | null>;
  /** Is the user/password form visible again? (The bank gave up on the scan.) */
  loginFormVisible(): Promise<boolean>;
  /** Positive proof of a logged-in session: the dashboard renders. */
  confirmDashboard(): Promise<boolean>;
  writePng(bytes: Uint8Array): Promise<void>;
  writeState(state: QrLoginState): Promise<void>;
  removePng(): Promise<void>;
  notify(text: string): Promise<void>;
}

export interface QrHandoffOptions {
  /** Goes into the state file and every Slack line. */
  reason: string;
  /** Where a human opens the QR. */
  pageUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
  notifyIntervalMs?: number;
  windowMs?: number;
}

// ── Slack text (contract-pinned, Thai) ────────────────────────────────────

export function qrWaitingMessage(opts: { reason: string; attempt: number; pageUrl: string }): string {
  return (
    `:lock: kbiz-bot: K BIZ ต้องสแกน QR เพื่อเข้าสู่ระบบ (${opts.reason}, QR #${opts.attempt}) — ` +
    `เปิด ${opts.pageUrl} บนคอมพิวเตอร์ แล้วสแกนด้วยแอป K BIZ ภายใน 5 นาที`
  );
}

export function qrSuccessMessage(reason: string): string {
  return `:white_check_mark: kbiz-bot: เข้าสู่ระบบ K BIZ แล้ว (${reason})`;
}

export function qrTimeoutMessage(): string {
  return ":hourglass: kbiz-bot: ไม่มีการสแกนใน 6.5 นาที — งานยังรออยู่ จะขอใหม่ใน 10 นาที";
}

// ── Masking ───────────────────────────────────────────────────────────────

/**
 * `state.json` is served on a Cloudflare-gated page and is the one artifact of
 * this flow a human reads, so it gets the same treatment as everything else
 * the bot publishes: no query strings (the bank's `loginQR.do?cmd=…` carries a
 * session token) and no long digit runs (an account number could reach here
 * only through an error message, which is exactly the accident to prevent).
 */
export function maskQrMessage(text: string): string {
  return text
    .replace(/\?\S*/g, "")
    .replace(/\d{6,}/g, "******")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Data-URI decoding ─────────────────────────────────────────────────────

const PNG_DATA_URI_PREFIX = /^data:image\/png;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * `img.qrcode`'s src → PNG bytes. STRICT on purpose: anything that is not a
 * real `data:image/png;base64,` payload is an `error`, never a file written
 * blind. A screenshot is never an acceptable substitute (it would publish the
 * surrounding page, session tokens and all).
 */
export function decodeQrDataUri(dataUri: string): Uint8Array {
  if (!PNG_DATA_URI_PREFIX.test(dataUri)) {
    throw new Error("QR image is not a data:image/png;base64 URI");
  }
  // All whitespace, not just the ends: a data URI wrapped across lines in the
  // bank's markup decodes fine in every browser, and rejecting it here would
  // abort the handoff over formatting. The PNG-magic check below still decides
  // what is allowed to reach disk.
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1).replace(/\s+/g, "");
  if (!b64 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new Error("QR image data URI is not valid base64");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("QR image bytes are not a PNG");
  }
  return bytes;
}

// ── Cooldown ──────────────────────────────────────────────────────────────

/**
 * May the batch ask for a scan right now? False only while a failed handoff's
 * cooldown is still running — that is the whole "skip the batch quietly, no
 * second Slack ping" rule, expressed as a pure function so it is testable
 * without a queue, a browser or a clock.
 */
export function shouldRequestQr(
  now: number,
  lastQrFailAt: number | null | undefined,
  cooldownMs: number = QR_COOLDOWN_MS,
): boolean {
  if (lastQrFailAt === null || lastQrFailAt === undefined) return true;
  return now - lastQrFailAt >= cooldownMs;
}

// ── State builders ────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

export function waitingState(opts: {
  reason: string;
  attempt: number;
  capturedAtMs: number;
  windowMs?: number;
}): QrLoginState {
  const windowMs = opts.windowMs ?? QR_WINDOW_MS;
  return {
    status: "waiting",
    reason: opts.reason,
    attempt: opts.attempt,
    capturedAt: iso(opts.capturedAtMs),
    expiresAt: iso(opts.capturedAtMs + windowMs),
    updatedAt: iso(opts.capturedAtMs),
    message: maskQrMessage(`QR #${opts.attempt} ready — scan it with the K BIZ app`),
  };
}

/**
 * Every non-`waiting` state. `capturedAt`/`expiresAt` go null deliberately:
 * they describe a PENDING scan, and once the handoff has resolved there isn't
 * one — leaving the old pair behind would render a live-looking countdown on
 * a page whose QR file has already been removed.
 */
export function terminalState(opts: {
  status: Exclude<QrLoginStatus, "waiting">;
  reason: string;
  attempt: number;
  atMs: number;
  message: string;
}): QrLoginState {
  return {
    status: opts.status,
    reason: opts.reason,
    attempt: opts.attempt,
    capturedAt: null,
    expiresAt: null,
    updatedAt: iso(opts.atMs),
    message: maskQrMessage(opts.message),
  };
}

// ── The loop ──────────────────────────────────────────────────────────────

/**
 * Publish the bank's QR, wait for a human to scan it, prove the session is up.
 *
 * Reads first and sleeps afterwards (the opposite of waitForApproval): the QR
 * is already on screen when we arrive and the human's 5:55 is already running,
 * so the first publish happens at t≈0, not at t≈2 s.
 *
 * Precedence per poll:
 *   1. the URL left /authen         → confirmDashboard() → `ok`, return
 *   2. a FRESH data URI             → decode, write PNG + `waiting`, notify
 *   3. the credentials form is back
 *      AND no QR on screen          → `expired`, throw QrLoginTimeoutError
 *   4. deadline                     → `expired`, throw QrLoginTimeoutError
 *
 * (1) outranks everything because a confirmed dashboard is the only positive
 * proof this function exists to obtain. (2) outranks (3) — the CR's order —
 * because a QR that is on screen is a QR a human can still scan: if the bank's
 * loginQR.do ever kept a visible `#userName` anywhere in its DOM, checking the
 * form first would file `expired` on the very first poll and no code would
 * ever be published. A decode failure is `error` + throw: publishing an
 * unverified blob would put an unknown image on a page an operator is told to
 * trust.
 *
 * Any OTHER throw (a full disk, a webhook that rejects) still takes the PNG
 * down on the way out: `current.png` on disk means "a live QR is waiting", and
 * an interrupted handoff must not leave that claim standing.
 */
export async function runQrHandoff(view: QrLoginView, opts: QrHandoffOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? QR_HANDOFF_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? QR_POLL_MS;
  const notifyIntervalMs = opts.notifyIntervalMs ?? QR_NOTIFY_INTERVAL_MS;
  const windowMs = opts.windowMs ?? QR_WINDOW_MS;
  const pageUrl = opts.pageUrl ?? DEFAULT_QR_PAGE_URL;
  const reason = opts.reason;

  const started = view.now();
  let attempt = 0;
  let lastDataUri: string | null = null;
  let lastNotifyAt: number | null = null;

  const settle = async (status: Exclude<QrLoginStatus, "waiting">, message: string) => {
    await view.removePng();
    await view.writeState(terminalState({ status, reason, attempt, atMs: view.now(), message }));
  };

  try {
    while (view.now() - started < timeoutMs) {
      // (1) The bank redirects itself away from /authen the moment the app
      //     confirms. Never trust the redirect alone — prove the dashboard.
      if (!isAuthenUrl(view.url())) {
        if (await view.confirmDashboard()) {
          await settle("ok", "Logged in");
          await view.notify(qrSuccessMessage(reason));
          return;
        }
        // Not (yet) a real session — fall through and keep waiting; the bank
        // may still be mid-redirect, and the deadline below bounds this.
      } else {
        // (2) A fresh QR (first, or rotated). Read BEFORE judging the form:
        //     a code on screen is a code a human can still scan.
        const dataUri = await view.qrDataUri().catch(() => null);
        if (dataUri && dataUri !== lastDataUri) {
          let bytes: Uint8Array;
          try {
            bytes = decodeQrDataUri(dataUri);
          } catch (e) {
            await settle("error", `Could not read the QR image: ${(e as Error).message}`);
            throw new Error(`QR login handoff failed: ${(e as Error).message}`);
          }
          lastDataUri = dataUri;
          attempt += 1;
          const capturedAtMs = view.now();
          await view.writePng(bytes);
          await view.writeState(waitingState({ reason, attempt, capturedAtMs, windowMs }));
          const firstQr = lastNotifyAt === null;
          if (firstQr || capturedAtMs - lastNotifyAt! >= notifyIntervalMs) {
            lastNotifyAt = capturedAtMs;
            await view.notify(qrWaitingMessage({ reason, attempt, pageUrl }));
          }
        } else if (dataUri === null && (await view.loginFormVisible())) {
          // (3) No QR anywhere AND the credentials form is back: the bank
          //     abandoned this round. With a QR still rendered this is not a
          //     bail-out — the human's window is still open.
          await settle("expired", "The bank returned to the login form before any scan");
          throw new QrLoginTimeoutError("K BIZ returned to the credentials form before the QR was scanned");
        }
      }

      await view.sleep(pollMs);
    }
  } catch (e) {
    // `settle()` already removed the PNG on every transition it owns; this
    // covers the ones it does not — a throw from writePng/writeState/notify/
    // sleep, or anything else unexpected. Published state may now be stale,
    // but a stale `waiting` state WITHOUT current.png renders as "no QR" on
    // the operator page, never as a dead code that looks live.
    await view.removePng().catch(() => {});
    throw e;
  }

  // (4) Nobody scanned. The caller's work is untouched and still queued.
  await settle("expired", "No scan before the deadline");
  throw new QrLoginTimeoutError();
}
