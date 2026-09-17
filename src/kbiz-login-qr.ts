// K BIZ QR login handoff — payroll-form's side (CR-2026-09-17).
//
// Since June 2026 K BIZ demands a scan from the K BIZ phone app after
// user/pass on every web login, so kbiz-bot cannot log in unattended. The bot
// keeps one session alive and NEVER starts a login by itself; the operator
// starts one from this page when a second screen is at hand. The bot
// publishes its session state and (during a handoff) the bank's QR to a
// directory both containers mount; this module reads them back and payroll-
// form serves them on Cloudflare-Access-gated routes (`KBIZ_QR_ROUTES`, wired
// in `src/index.ts`).
//
// fs-only, fixed filenames. It never lists the directory and never takes a
// filename from a request — the only four files in this contract are the
// constants below, so no request can steer a read (or a write) anywhere else.
// The ONE thing it writes is `login.request`, the operator's button press.
//
// The directory is resolved PER CALL (not once at import) so the route can be
// pointed at a fixture dir in tests without restarting the process.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACCESS_EMAIL_HEADER } from "./property-hint";
import { renderKbizLoginQrPage } from "./views/kbiz-login-qr";

/** The contract's four paths, spelled once for `src/index.ts` and the view. */
export const KBIZ_QR_ROUTES = {
  page: "/kbiz/login-qr",
  png: "/kbiz/login-qr.png",
  state: "/kbiz/login-qr/state.json",
  request: "/kbiz/login-qr/request",
} as const;

/** The bot's files; the only names this module ever reads. */
export const KBIZ_QR_STATE_FILE = "state.json";
export const KBIZ_QR_PNG_FILE = "current.png";
export const KBIZ_SESSION_FILE = "session.json";

/**
 * The operator's button press — the only file payroll-form writes, and the
 * only way a login ever starts. The bot CLAIMS it by renaming it to
 * `login.request.claimed` before it touches the bank; payroll-form never
 * deletes it, so "the file is there" means "a login is being prepared".
 */
export const KBIZ_LOGIN_REQUEST_FILE = "login.request";

/**
 * A FRESH tmp name per write. payroll-form serves this POST concurrently (two
 * operator tabs, or one page firing twice), and a single shared tmp path is
 * not an atomic write at all: two writers open the SAME file with O_TRUNC,
 * both write from offset 0, and the rename publishes whatever mixture landed.
 * Per-write names are what the bot's own writers do (`payee-handles.ts`,
 * `payroll-bank-backfill.ts`); the rename stays the atomic publish step.
 */
const loginRequestTmp = () => `.${KBIZ_LOGIN_REQUEST_FILE}.${randomUUID()}.tmp`;

/** The four the bot publishes — the one list the type and the guard share. */
const BOT_STATUSES = ["waiting", "ok", "expired", "error"] as const;
const BOT_STATUS_SET: ReadonlySet<string> = new Set(BOT_STATUSES);

/**
 * `idle` is payroll-form's own synthesis for "the bot has never published
 * here / there is nothing pending"; the bot only ever writes the other four.
 */
export type KbizQrStatus = "idle" | (typeof BOT_STATUSES)[number];

/**
 * The published state, narrowed to the contract's fields. Anything else in the
 * file is dropped rather than forwarded — this response leaves the origin.
 */
export type KbizQrState = {
  status: KbizQrStatus;
  reason?: string;
  attempt?: number;
  capturedAt?: string | null;
  expiresAt?: string | null;
  updatedAt?: string | null;
  message?: string;
};

/**
 * `session.json`, narrowed to the contract's fields. Written by the bot's
 * session keeper on every check; `pending` is the count of approved queue
 * items waiting, `lastLifetimeMs` the length of the last session that died.
 */
export type KbizSession = {
  alive: boolean;
  since: string | null;
  checkedAt: string | null;
  endedAt: string | null;
  lastLifetimeMs: number | null;
  pending: number;
  note?: string;
};

/** `login.request`, narrowed. `by` is informational only — see below. */
export type KbizLoginRequest = {
  requestedAt: string | null;
  by: string;
};

/**
 * What the page and the poll both see: the QR publication plus, when the files
 * exist, the session and the outstanding request. The two extra keys are
 * ABSENT (not null) when their file is missing, so `status`-only consumers see
 * exactly the object they saw before this CR.
 */
export type KbizPageState = KbizQrState & {
  session?: KbizSession;
  request?: KbizLoginRequest;
};

/** `KBIZ_QR_DIR` ?? `data/qr-login` (cwd `/app` in the container). */
export function kbizQrDir(dir?: string): string {
  return dir ?? process.env.KBIZ_QR_DIR ?? "data/qr-login";
}

const NO_STORE = "private, no-store";

/** What `by` says when Cloudflare Access sent no identity we can record. */
const UNKNOWN_BY = "unknown";

/**
 * An email-ish shape, and deliberately narrower than RFC 5321: `<`, `>`, `|`,
 * quotes and backslashes are excluded because this value LEAVES the app — the
 * bot echoes it into a Slack line, where `<url|label>` renders as a clickable
 * link with attacker-chosen text. Lengths (64 + 1 + 189) cap the whole value
 * at the 254 this used to check. Anything else is recorded as `unknown`.
 */
const ACCESS_EMAIL_SHAPE = /^[^\s<>|"'\\]{1,64}@[^\s<>|"'\\]{1,189}$/;

const noStore = (body: BodyInit, contentType: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": contentType, "cache-control": NO_STORE } });

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const instant = (value: unknown): string | null | undefined =>
  typeof value === "string" && value.length > 0 ? value : value === null ? null : undefined;

/**
 * A `waiting` whose deadline has already passed is stale: the bank's QR is
 * dead, and the publisher may have died before rewriting the file. Read it
 * back as `expired` so the page says so and the PNG route (gated on
 * `waiting`) stops serving an unscannable image. An absent or unparseable
 * `expiresAt` is left alone — only a real, past deadline downgrades.
 */
function isStale(state: KbizQrState): boolean {
  if (state.status !== "waiting" || !state.expiresAt) return false;
  const deadline = Date.parse(state.expiresAt);
  return Number.isFinite(deadline) && deadline <= Date.now();
}

function normalize(parsed: unknown): KbizQrState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "error" };
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.status !== "string" || !BOT_STATUS_SET.has(raw.status)) return { status: "error" };
  const state: KbizQrState = { status: raw.status as KbizQrStatus };
  const reason = str(raw.reason);
  if (reason !== undefined) state.reason = reason;
  if (typeof raw.attempt === "number" && Number.isInteger(raw.attempt) && raw.attempt > 0) {
    state.attempt = raw.attempt;
  }
  for (const key of ["capturedAt", "expiresAt", "updatedAt"] as const) {
    const value = instant(raw[key]);
    if (value !== undefined) state[key] = value;
  }
  const message = str(raw.message);
  if (message !== undefined) state.message = message;
  return isStale(state) ? { ...state, status: "expired" } : state;
}

/**
 * Never throws. Missing file (or missing directory) is `idle` — the contract's
 * synthesised state. Anything unreadable or malformed is `error`, because a
 * broken publish must not look like "nothing is pending".
 */
export async function readKbizQrState(dir?: string): Promise<KbizQrState> {
  let text: string;
  try {
    text = await readFile(join(kbizQrDir(dir), KBIZ_QR_STATE_FILE), "utf8");
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { status: "idle" } : { status: "error" };
  }
  try {
    return normalize(JSON.parse(text));
  } catch {
    return { status: "error" };
  }
}

/** Reads one of the bot's JSON files. `null` = absent, unreadable or not an object. */
async function readJsonObject(dir: string, file: string): Promise<Record<string, unknown> | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;

const millis = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * The keeper's view of the bank session. `null` when the bot has never written
 * one (or wrote something with no boolean `alive` — a file we cannot read as a
 * session must not be rendered as "logged in").
 */
export async function readKbizSession(dir?: string): Promise<KbizSession | null> {
  const raw = await readJsonObject(kbizQrDir(dir), KBIZ_SESSION_FILE);
  if (!raw || raw === "unreadable" || typeof raw.alive !== "boolean") return null;
  const session: KbizSession = {
    alive: raw.alive,
    since: instant(raw.since) ?? null,
    checkedAt: instant(raw.checkedAt) ?? null,
    endedAt: instant(raw.endedAt) ?? null,
    lastLifetimeMs: millis(raw.lastLifetimeMs),
    pending: count(raw.pending),
  };
  const note = str(raw.note);
  if (note !== undefined) session.note = note;
  return session;
}

/**
 * The outstanding button press, or `null` when there is none. A file that
 * exists but does not parse still counts as a request: the bot claims it by
 * name, so "a login is being prepared" is the truthful thing to show — better
 * than offering a button that would write over a request already in flight.
 */
export async function readKbizLoginRequest(dir?: string): Promise<KbizLoginRequest | null> {
  const raw = await readJsonObject(kbizQrDir(dir), KBIZ_LOGIN_REQUEST_FILE);
  if (!raw) return null;
  if (raw === "unreadable") return { requestedAt: null, by: UNKNOWN_BY };
  return { requestedAt: instant(raw.requestedAt) ?? null, by: str(raw.by) ?? UNKNOWN_BY };
}

/**
 * Everything one poll has to carry: the QR publication plus the session and
 * the outstanding request, so the page can derive all four states (and the
 * button) without a second round trip.
 */
export async function readKbizPageState(dir?: string): Promise<KbizPageState> {
  const resolved = kbizQrDir(dir);
  const [state, session, request] = await Promise.all([
    readKbizQrState(resolved),
    readKbizSession(resolved),
    readKbizLoginRequest(resolved),
  ]);
  return { ...state, ...(session ? { session } : {}), ...(request ? { request } : {}) };
}

/** The published PNG bytes, or `null` when there is no readable QR on disk. */
async function readKbizQrPng(dir?: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(kbizQrDir(dir), KBIZ_QR_PNG_FILE));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route bodies. Kept beside the reader (rather than inline in `src/index.ts`)
// so the same four responses tests exercise are the ones the app serves.
// Every one is `private, no-store`: the QR is single-use and short-lived, and
// the page is only ever correct for the instant it was rendered.
// ---------------------------------------------------------------------------

type RouteOptions = { dir?: string };

/** Elysia hands the route a plain, lower-cased header bag (see `property-hint.ts`). */
type RequestHeaders = Record<string, string | undefined> | null | undefined;

export async function kbizLoginQrPageResponse(options: RouteOptions = {}): Promise<Response> {
  const state = await readKbizPageState(options.dir);
  return noStore(renderKbizLoginQrPage(state, KBIZ_QR_ROUTES), "text/html; charset=utf-8");
}

export async function kbizLoginQrStateResponse(options: RouteOptions = {}): Promise<Response> {
  const state = await readKbizPageState(options.dir);
  return noStore(JSON.stringify(state), "application/json; charset=utf-8");
}

/**
 * Who pressed the button, for the record only.
 *
 * The value is the identity Cloudflare Access injected, and NOTHING here
 * verifies it — the same posture as `src/property-hint.ts`: this app has no
 * app-level auth at all, the whole hostname is gated at the edge, and `by`
 * authorizes nothing. It is written so the bot's Slack line can say who asked
 * and so a stray request has a name on it. Anything odd (no header, a control
 * character, an absurd length) degrades to `"unknown"` rather than putting
 * junk into a file the bot reads and Slacks.
 */
function requestedBy(headers: RequestHeaders): string {
  const raw = headers?.[ACCESS_EMAIL_HEADER];
  if (typeof raw !== "string") return UNKNOWN_BY;
  const email = raw.trim();
  const printable = email.length > 0 && ![...email].some((ch) => ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f);
  return printable && ACCESS_EMAIL_SHAPE.test(email) ? email : UNKNOWN_BY;
}

/**
 * The operator pressed "เข้าสู่ระบบ K BIZ". Writes `login.request` atomically
 * (tmp + rename, like every other writer in this contract) and answers 202;
 * the bot picks it up on its next tick and the page's 5 s poll shows progress.
 *
 * Never a login by itself, and never a second one: a QR already on screen is a
 * 409 (nothing to ask for — go scan it), and an unclaimed request is answered
 * `already` rather than overwritten, so a double tap cannot rewrite the "by"
 * and "requestedAt" of a request the bot may be acting on this instant.
 *
 * Auth: the whole-hostname Cloudflare Access app, exactly like the page. A
 * cross-site POST can at worst make the bot show a login QR that only the
 * owner's phone can complete — accepted in the CR. The body is ignored.
 */
export async function kbizLoginRequestResponse(
  options: RouteOptions & { headers?: RequestHeaders } = {},
): Promise<Response> {
  const dir = kbizQrDir(options.dir);
  const json = (body: unknown, status: number) =>
    noStore(JSON.stringify(body), "application/json; charset=utf-8", status);

  // `readKbizQrState` has already downgraded a past-deadline `waiting` to
  // `expired`, so "still waiting" here means "and not stale" in one test.
  const state = await readKbizQrState(dir);
  if (state.status === "waiting") return json({ error: "qr-already-showing" }, 409);
  if (await readKbizLoginRequest(dir)) return json({ accepted: true, already: true }, 202);

  const request: KbizLoginRequest = { requestedAt: new Date().toISOString(), by: requestedBy(options.headers) };
  const tmp = join(dir, loginRequestTmp());
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(request)}\n`, "utf8");
    await rename(tmp, join(dir, KBIZ_LOGIN_REQUEST_FILE));
  } catch {
    // The bot never sees a half-written request; the operator sees a button
    // that is still there and an error, which is the truthful outcome. A tmp
    // left behind by a failed write is swept here so the dir cannot silt up.
    await rm(tmp, { force: true }).catch(() => {});
    return json({ error: "request-write-failed" }, 500);
  }
  return json({ accepted: true }, 202);
}

/**
 * The PNG exists only while a scan is actually pending: `waiting` in the state
 * file AND `current.png` on disk. A stale image left behind by a crashed
 * publish must never be shown as if it were scannable — and a `waiting` past
 * its deadline is no longer `waiting` by the time the reader returns it.
 */
export async function kbizLoginQrPngResponse(options: RouteOptions = {}): Promise<Response> {
  const dir = kbizQrDir(options.dir);
  const state = await readKbizQrState(dir);
  const png = state.status === "waiting" ? await readKbizQrPng(dir) : null;
  return png ? noStore(png, "image/png") : noStore("no QR pending", "text/plain; charset=utf-8", 404);
}
