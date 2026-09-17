/**
 * The resident K BIZ session, as a PURE reducer.
 *
 * CR-2026-09-17 (resident session): the bot no longer starts a login on its
 * own. It keeps ONE Chromium context for the process lifetime, pings the bank
 * every few minutes to prove the session is still up, publishes what it knows
 * to `session.json`, and asks a human — in Slack, with a link — to press the
 * button on the operator page when the session is gone. The K BIZ app cannot
 * scan a QR from a saved picture, so a QR nobody asked for is a QR nobody can
 * use; the operator presses the button when a SECOND screen is at hand.
 *
 * Everything this file decides is a pure function of (state, input): which
 * action(s) a tick takes, the nudge/reminder rate limits, the session-lifetime
 * arithmetic and the Bangkok day boundary. No playwright, no fs, no Date.now()
 * — `nowMs` is always passed in, so a whole day of ticks runs in microseconds
 * under a virtual clock (test/session-keeper-core.test.ts). Root CI runs
 * `bun test` BEFORE kbiz-bot's node_modules exist, so this file must never
 * import "playwright", not even `import type`.
 *
 * This module decides NOTHING about money. The item loop, the arm gate, the
 * arm lock and the phone tap are untouched by it — it only decides WHEN the
 * queue step is allowed to run at all.
 */

import {
  loginReminderMessage,
  sessionAliveMessage,
  sessionEndedMessage,
  workWaitingMessage,
} from "./qr-login-core";

// ── Cadences (the contract's defaults; env overrides live in the driver) ───

/** How often the loop wakes up. Everything below is measured against it. */
export const DEFAULT_TICK_MS = 5_000;
/** How stale a "the session is alive" observation may get before we re-prove it. */
export const DEFAULT_KEEPALIVE_MS = 240_000;
/** The queue step's own cadence — unchanged from the pre-keeper watch loop. */
export const DEFAULT_QUEUE_POLL_MS = 30_000;
/** A "work is waiting" nudge repeats at most this often while the count holds. */
export const NUDGE_INTERVAL_MS = 60 * 60_000;
/**
 * How many consecutive UNCLASSIFIED check failures it takes to call the session
 * dead. A bank outage, a network blip or a context that vanished mid-navigation
 * carries none of the contract's death signals, and treating the first one as a
 * death would send a "หมดอายุแล้ว" nobody can act on, write the blip's duration
 * into `lastLifetimeMs` (our only reading of the bank's session cap) and then
 * wait for a human who is not needed. The counter is fed by BOTH the keepalive
 * (every KBIZ_KEEPALIVE_MS while quiet) and the batch warm-up (every
 * QUEUE_POLL_MS while work is waiting), so three in a row is ~12 minutes of an
 * unreachable bank on a quiet day and only a few minutes with money queued —
 * still three real round-trips, never a single blip.
 */
export const UNCLASSIFIED_FAILURE_LIMIT = 3;
/**
 * The morning reminder is a MORNING line: it may fire inside this window past
 * `reminderMinuteOfDay` and nowhere else. Without it, a container that starts
 * at 23:00 while the session is dead posts ":sunrise: … ยังไม่ได้เข้าสู่ระบบ"
 * on its first tick, and the one Slack line whose whole value is "it is
 * morning" becomes noise. The work-waiting nudge covers a dead session with
 * real work outside the window.
 */
export const REMINDER_WINDOW_MS = 60 * 60_000;
/** Asia/Bangkok, 08:30. */
export const DEFAULT_REMINDER_HHMM = "08:30";
/** Asia/Bangkok is UTC+7 year-round — no DST, so a fixed offset is exact. */
export const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;

// ── State ─────────────────────────────────────────────────────────────────

/**
 * Everything the keeper remembers between ticks.
 *
 * There is deliberately NO `alive` field: a live session is exactly one with a
 * `sinceMs`, and a dead one has `endedAtMs`/`lastLifetimeMs` describing the
 * last one that ended. One source of truth means "alive but no since" and
 * "since but not alive" are unrepresentable. `isAlive(state)` is what the
 * driver feeds back in as `input.alive`.
 */
export interface KeeperState {
  /** When the CURRENT session was first seen alive; null while dead. */
  sinceMs: number | null;
  /** The last keepalive/login check of any kind. */
  checkedAtMs: number | null;
  /** When the last session was found dead; null until one ends. */
  endedAtMs: number | null;
  /** `endedAt - since` of the most recent ENDED session — the instrument that
   *  tells us the bank's session cap. Null until one ends. */
  lastLifetimeMs: number | null;
  /** Approved queue items waiting (0 when none). */
  pending: number;
  /** Short masked text, e.g. "keepalive ok" / "bounced to login". */
  note: string;
  /** Has the CURRENT death already been announced? True in the initial state:
   *  a bot that starts up dead never saw a session end, so there is nothing to
   *  report and no lifetime to report it with. */
  deathReported: boolean;
  lastNudgeAtMs: number | null;
  /** The pending count the last nudge named — a CHANGE re-nudges at once. */
  lastNudgeCount: number | null;
  /** Bangkok calendar day (YYYY-MM-DD) the morning reminder last fired on. */
  lastReminderDay: string | null;
  /** Check failures in a row that carried none of the contract's death
   *  signals. Reset by any check that resolves either way. */
  consecutiveUnclassifiedFailures: number;
  /** Chromium launches that failed in a row — the reopen backoff's exponent. */
  reopenFailures: number;
  /** When a reopen was last ASKED for (stamped at decision time, so a launch
   *  that throws cannot be retried 12×/min). */
  lastReopenAtMs: number | null;
  /** When the queue step last ran (decided, or completed — the driver stamps
   *  it again on completion so a long batch does not re-poll immediately). */
  lastQueueAtMs: number | null;
}

export function initialKeeperState(): KeeperState {
  return {
    sinceMs: null,
    checkedAtMs: null,
    endedAtMs: null,
    lastLifetimeMs: null,
    pending: 0,
    note: "starting up",
    deathReported: true,
    lastNudgeAtMs: null,
    lastNudgeCount: null,
    lastReminderDay: null,
    consecutiveUnclassifiedFailures: 0,
    reopenFailures: 0,
    lastReopenAtMs: null,
    lastQueueAtMs: null,
  };
}

/**
 * A process that starts AFTER the reminder time has no morning to remind about.
 *
 * `lastReminderDay` lives only in memory, so without this a redeploy at 14:00
 * on a day the operator has not logged in posts the 08:30 sunrise line at
 * 14:00 — and again at every later restart that day. Seeding the day at startup
 * makes the contract's "once per calendar day" true across restarts, not just
 * within one process.
 */
export function seedReminderDay(state: KeeperState, nowMs: number, config: KeeperConfig): KeeperState {
  if (config.reminderMinuteOfDay === null) return state;
  if (bangkokMinuteOfDay(nowMs) < config.reminderMinuteOfDay) return state;
  return { ...state, lastReminderDay: bangkokDay(nowMs) };
}

/** A live session is exactly one with a `since`. */
export const isAlive = (state: KeeperState): boolean => state.sinceMs !== null;

// ── Actions ───────────────────────────────────────────────────────────────

/**
 * What a tick asks the driver to do, in the order the driver must do it.
 *
 * - `reopen-browser`  — the persistent context is gone (crash, `docker stop`
 *                       race); reopen it, then check.
 * - `claim-and-login` — an operator pressed the button: claim `login.request`
 *                       BEFORE touching the bank, then run the QR handoff.
 * - `keepalive-check` — prove the session is still up (refuse policy).
 * - `run-queue`       — the 30 s queue step (handles, batch, settlement).
 * - `session-ended`   — Slack the "หมดอายุ" line, once per death.
 * - `nudge`           — Slack "มี n งานรอ" while dead.
 * - `reminder`        — Slack the 08:30 Bangkok morning reminder while dead.
 */
export type KeeperAction =
  | "reopen-browser"
  | "claim-and-login"
  | "keepalive-check"
  | "run-queue"
  | "session-ended"
  | "nudge"
  | "reminder";

export interface KeeperTickInput {
  nowMs: number;
  /** `isAlive(state)` — passed in so the driver and the reducer can never
   *  disagree about which session this tick is reasoning over. */
  alive: boolean;
  /** Is `login.request` on disk right now? */
  requestPresent: boolean;
  /** Is a QR handoff running? It owns the single page while it does. */
  handoffInProgress: boolean;
  /** Approved queue items as of the last queue step. */
  approvedCount: number;
  /** Is the persistent context open? */
  browserOpen: boolean;
}

export interface KeeperConfig {
  /** How often the loop wakes up — also the reopen backoff's base unit. */
  tickMs: number;
  keepaliveMs: number;
  queuePollMs: number;
  /** Minutes past Bangkok midnight, or null to disable the reminder. */
  reminderMinuteOfDay: number | null;
}

export function defaultKeeperConfig(): KeeperConfig {
  return {
    tickMs: DEFAULT_TICK_MS,
    keepaliveMs: DEFAULT_KEEPALIVE_MS,
    queuePollMs: DEFAULT_QUEUE_POLL_MS,
    reminderMinuteOfDay: parseReminderHhmm(DEFAULT_REMINDER_HHMM),
  };
}

export interface KeeperTickResult {
  actions: KeeperAction[];
  state: KeeperState;
}

/**
 * Due when we have never done it, when the interval has elapsed — or when the
 * clock has jumped BACKWARDS past the last stamp, which would otherwise wedge
 * the keepalive and the queue step until real time caught up again. (The
 * nudge deliberately does NOT use this: staying quiet is the harmless
 * direction for a Slack ping, and a changed count re-opens it anyway.)
 */
function due(lastMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (lastMs === null) return true;
  if (nowMs < lastMs) return true;
  return nowMs - lastMs >= intervalMs;
}

/**
 * One tick of the resident loop, in the contract's order:
 *
 *   0. the browser is gone      → reopen (then re-check a session we believed alive)
 *   1. an operator pressed it   → claim + login, and NOTHING else this tick
 *   2. alive and the ping is due→ keepalive check
 *   3. the queue cadence is due → the queue step
 *   4. dead with work waiting   → nudge (on a count change, else hourly)
 *   5. dead past 08:30 Bangkok  → the morning reminder, once per day
 *
 * A handoff in progress blocks (2) and (3): there is ONE page, and it is
 * showing the bank's QR.
 */
export function decideTick(
  state: KeeperState,
  input: KeeperTickInput,
  config: KeeperConfig = defaultKeeperConfig(),
): KeeperTickResult {
  const actions: KeeperAction[] = [];
  let next = state;

  // (0) No page, no decisions worth making: reopen first. Cookies live in the
  //     profile volume, so a reopened context usually still holds the session
  //     — which is exactly why a session we believed alive is re-checked here
  //     rather than assumed dead. A session we already know is dead is NOT
  //     re-checked: that check would only re-submit credentials to earn a QR
  //     nobody asked for.
  if (!input.browserOpen) {
    // …but a launch that keeps failing (a profile lock held by a stray
    // `npm run login`, no disk, no /dev/shm) must not be retried every tick
    // forever: back off from one tick to the keepalive interval. Stamped at
    // DECISION time, so a `reopen()` that throws still counts as an attempt.
    if (!due(state.lastReopenAtMs, input.nowMs, reopenBackoffMs(state.reopenFailures, config))) {
      return { actions, state: next };
    }
    next = { ...next, lastReopenAtMs: input.nowMs };
    actions.push("reopen-browser");
    if (input.alive) actions.push("keepalive-check");
    return { actions, state: next };
  }

  // (1) The operator's button. Claiming happens in the driver, BEFORE the bank
  //     is touched, exactly like payroll-bank-backfill's request/claim. The
  //     login owns the rest of this tick — the page is about to be busy for up
  //     to 6.5 minutes, and a nudge or reminder posted alongside it would tell
  //     the operator to press a button they have just pressed.
  if (input.requestPresent && !input.handoffInProgress) {
    actions.push("claim-and-login");
    return { actions, state: next };
  }

  // (2) Keepalive. Only while alive: a dead session's "check" is a credential
  //     submission that ends on a QR page, and this bot never asks for a scan
  //     nobody requested.
  if (input.alive && !input.handoffInProgress && due(state.checkedAtMs, input.nowMs, config.keepaliveMs)) {
    actions.push("keepalive-check");
  }

  // (3) The queue step keeps its own 30 s cadence whether the session is alive
  //     or not — the driver still needs the approved count to nudge with.
  if (!input.handoffInProgress && due(state.lastQueueAtMs, input.nowMs, config.queuePollMs)) {
    actions.push("run-queue");
    next = { ...next, lastQueueAtMs: input.nowMs };
  }

  // (4) Work waiting on a dead session.
  if (!input.alive && input.approvedCount > 0 && nudgeDue(next, input)) {
    actions.push("nudge");
    next = { ...next, lastNudgeAtMs: input.nowMs, lastNudgeCount: input.approvedCount };
  }

  // (5) The morning reminder.
  if (!input.alive && config.reminderMinuteOfDay !== null) {
    const day = bangkokDay(input.nowMs);
    const minute = bangkokMinuteOfDay(input.nowMs);
    const inWindow =
      minute >= config.reminderMinuteOfDay && minute < config.reminderMinuteOfDay + REMINDER_WINDOW_MS / 60_000;
    if (inWindow && next.lastReminderDay !== day) {
      actions.push("reminder");
      next = { ...next, lastReminderDay: day };
    }
  }

  return { actions, state: next };
}

/**
 * How long to wait before asking for another Chromium launch, after `failures`
 * in a row: one tick, then 2, 4, 8 … capped at the keepalive interval. The
 * pre-CR watch loop retried a failed launch at the 30 s poll; this is the same
 * spirit, with the first retry as prompt as it always was.
 */
export function reopenBackoffMs(failures: number, config: KeeperConfig): number {
  const steps = Math.min(Math.max(0, Math.trunc(failures)), 20);
  return Math.min(config.tickMs * 2 ** steps, config.keepaliveMs);
}

/** The driver tried to reopen the context and it either worked or it did not.
 *  Success clears the backoff; failure lengthens it. */
export function markReopened(state: KeeperState, ok: boolean): KeeperState {
  return { ...state, reopenFailures: ok ? 0 : state.reopenFailures + 1 };
}

/** A changed count is news and goes out at once; an unchanged one repeats at
 *  most hourly. Both conditions are the contract's, verbatim. */
function nudgeDue(state: KeeperState, input: KeeperTickInput): boolean {
  if (state.lastNudgeCount !== input.approvedCount) return true;
  if (state.lastNudgeAtMs === null) return true;
  return input.nowMs - state.lastNudgeAtMs >= NUDGE_INTERVAL_MS;
}

// ── Applying what the driver observed ─────────────────────────────────────

export interface KeeperCheckOutcome {
  nowMs: number;
  alive: boolean;
  /** Short, already-masked text for `session.json`'s `note`. */
  note: string;
  /** The failure carried NONE of the contract's death signals (the driver
   *  classifies — `isSessionDeathError`). Ignored when `alive`. */
  unclassified?: boolean;
}

/**
 * Fold one check's result into the state.
 *
 * The lifetime instrument lives here: a session that was alive and is now dead
 * stamps `endedAt` and `lastLifetimeMs = endedAt - since`, and emits
 * `session-ended` EXACTLY ONCE (every later dead check finds `deathReported`
 * already set). A bot that starts up dead reports nothing — it never saw that
 * session alive, so it has no lifetime to report and no death to announce.
 */
export function applyCheckResult(state: KeeperState, outcome: KeeperCheckOutcome): KeeperTickResult {
  const actions: KeeperAction[] = [];
  let next: KeeperState = {
    ...state,
    checkedAtMs: outcome.nowMs,
    note: outcome.note,
    consecutiveUnclassifiedFailures: 0,
  };

  if (outcome.alive) {
    if (state.sinceMs === null) {
      // A new session. `since` is when we FIRST saw it — after a restart that
      // inherited a live profile, that is later than the real login, so the
      // first reported lifetime under-reports. It never over-reports.
      next = { ...next, sinceMs: outcome.nowMs, deathReported: false };
    }
    return { actions, state: next };
  }

  // An UNCLASSIFIED failure is not proof of anything: a bank outage, a network
  // blip or a context that went away mid-navigation all land here. Count it,
  // keep the session exactly as it was (`checkedAtMs` is stamped, so the retry
  // comes at the next keepalive rather than 5 s later), and only call the
  // session dead once they stack up. Everything the false death would have cost
  // — the "หมดอายุแล้ว" line, a blip written into `lastLifetimeMs`, a bot that
  // then never re-checks because `decideTick` only pings while alive — is
  // avoided by these three lines.
  if (outcome.unclassified) {
    const failures = state.consecutiveUnclassifiedFailures + 1;
    if (failures < UNCLASSIFIED_FAILURE_LIMIT) {
      return { actions, state: { ...next, consecutiveUnclassifiedFailures: failures } };
    }
  }

  if (state.sinceMs !== null) {
    next = {
      ...next,
      sinceMs: null,
      endedAtMs: outcome.nowMs,
      lastLifetimeMs: Math.max(0, outcome.nowMs - state.sinceMs),
    };
  }
  if (!next.deathReported) {
    actions.push("session-ended");
    next = { ...next, deathReported: true };
  }
  return { actions, state: next };
}

/** The queue step finished — restamp so a long batch (minutes of phone taps)
 *  does not make the very next tick poll again. */
export function markQueueRan(state: KeeperState, nowMs: number): KeeperState {
  return { ...state, lastQueueAtMs: nowMs };
}

/** The approved-item count the queue step just observed. */
export function setPending(state: KeeperState, pending: number): KeeperState {
  return { ...state, pending: Math.max(0, Math.trunc(pending)) };
}

/** A note with no check behind it (a reopened browser, a claimed request). */
export function withNote(state: KeeperState, note: string): KeeperState {
  return { ...state, note };
}

// ── session.json ──────────────────────────────────────────────────────────

/**
 * The published record. payroll-form derives its page states from this file
 * plus `state.json` plus `login.request` — see the CR's page-state table.
 */
export interface KbizSessionFile {
  alive: boolean;
  /** ISO — when this session was first seen alive, or null. */
  since: string | null;
  /** ISO — last keepalive check. */
  checkedAt: string | null;
  /** ISO — when the last session was found dead, or null. */
  endedAt: string | null;
  lastLifetimeMs: number | null;
  pending: number;
  note: string;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function sessionFileFrom(state: KeeperState): KbizSessionFile {
  return {
    alive: isAlive(state),
    since: iso(state.sinceMs),
    checkedAt: iso(state.checkedAtMs),
    endedAt: iso(state.endedAtMs),
    lastLifetimeMs: state.lastLifetimeMs,
    pending: state.pending,
    note: state.note,
  };
}

// ── Asia/Bangkok arithmetic (fixed +7, no DST) ────────────────────────────

/** The Bangkok calendar day (YYYY-MM-DD) `nowMs` falls in. */
export function bangkokDay(nowMs: number): string {
  return new Date(nowMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes past Bangkok midnight. */
export function bangkokMinuteOfDay(nowMs: number): number {
  const d = new Date(nowMs + BANGKOK_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** `"08:30"` → 510. Anything else → null, which disables the reminder rather
 *  than silently nagging at midnight. */
export function parseReminderHhmm(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

// ── The Slack line for each action ────────────────────────────────────────

/**
 * One place that turns an action into the contract's Thai text, so a caller
 * cannot pick the wrong line for the state it is in. `claim-and-login` and
 * `keepalive-check` have no line of their own: the QR handoff posts its own
 * `:lock:` / `:white_check_mark:` / `:hourglass:` lines, and a successful
 * keepalive is deliberately silent.
 */
export function keeperSlackLine(
  action: KeeperAction,
  ctx: { pageUrl: string; lifetimeMs?: number | null; pending?: number },
): string | null {
  switch (action) {
    case "session-ended":
      return sessionEndedMessage({ lifetimeMs: ctx.lifetimeMs ?? null, pageUrl: ctx.pageUrl });
    case "nudge":
      return workWaitingMessage({ count: ctx.pending ?? 0, pageUrl: ctx.pageUrl });
    case "reminder":
      return loginReminderMessage({ pageUrl: ctx.pageUrl });
    default:
      return null;
  }
}

export { sessionAliveMessage };
