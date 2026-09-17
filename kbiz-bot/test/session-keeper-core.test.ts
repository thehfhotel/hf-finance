// The resident session keeper's decisions, on a virtual clock.
//
// Everything here is pure: no browser, no filesystem, no real time. `nowMs` is
// a plain number the test advances by hand, so a full Bangkok day of ticks
// runs in microseconds and deterministically — the same idiom
// test/support/frame-clock.ts gives the QR handoff. Nothing in this file may
// import "playwright", not even `import type`: root CI runs `bun test` BEFORE
// kbiz-bot's node_modules exist.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  applyCheckResult,
  bangkokDay,
  bangkokMinuteOfDay,
  decideTick,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_QUEUE_POLL_MS,
  DEFAULT_REMINDER_HHMM,
  DEFAULT_TICK_MS,
  defaultKeeperConfig,
  initialKeeperState,
  isAlive,
  keeperSlackLine,
  markQueueRan,
  markReopened,
  NUDGE_INTERVAL_MS,
  parseReminderHhmm,
  reopenBackoffMs,
  seedReminderDay,
  sessionFileFrom,
  setPending,
  UNCLASSIFIED_FAILURE_LIMIT,
  withNote,
  type KeeperAction,
  type KeeperState,
  type KeeperTickInput,
} from "../src/lib/session-keeper-core";
import {
  formatSessionLifetime,
  loginReminderMessage,
  sessionAliveMessage,
  sessionEndedMessage,
  workWaitingMessage,
} from "../src/lib/qr-login-core";

const PAGE_URL = "https://payroll.example.org/kbiz/login-qr";

/** 2026-09-17T00:00:00Z = 07:00 Bangkok — a fixed epoch, never a real clock. */
const T0 = Date.parse("2026-09-17T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Bangkok wall-clock → epoch ms (UTC+7, no DST). */
const bkk = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000+07:00`);

const config = defaultKeeperConfig();

function tick(state: KeeperState, over: Partial<KeeperTickInput> = {}) {
  const input: KeeperTickInput = {
    nowMs: T0,
    alive: isAlive(state),
    requestPresent: false,
    handoffInProgress: false,
    approvedCount: 0,
    browserOpen: true,
    ...over,
  };
  return decideTick(state, { ...input, alive: over.alive ?? isAlive(state) }, config);
}

/** A state that has been alive since T0 and was last checked at T0. */
function live(atMs = T0): KeeperState {
  const { state } = applyCheckResult(initialKeeperState(), { nowMs: atMs, alive: true, note: "keepalive ok" });
  return state;
}

// ── The first check ───────────────────────────────────────────────────────

describe("the first check", () => {
  it("starts a session and stamps `since`", () => {
    const state = live();
    expect(isAlive(state)).toBe(true);
    expect(state.sinceMs).toBe(T0);
    expect(state.checkedAtMs).toBe(T0);
    expect(state.endedAtMs).toBeNull();
    expect(state.lastLifetimeMs).toBeNull();
  });

  it("says nothing when the bot starts up on a session that is ALREADY dead", () => {
    // Nothing ended: we never saw that session alive, so there is no lifetime
    // to report and no death to announce. The morning reminder and the "งานรอ"
    // nudge are what cover a bot that comes up with no session.
    const { state, actions } = applyCheckResult(initialKeeperState(), {
      nowMs: T0,
      alive: false,
      note: "bounced to login",
    });
    expect(actions).toEqual([]);
    expect(isAlive(state)).toBe(false);
    expect(state.lastLifetimeMs).toBeNull();
    expect(state.endedAtMs).toBeNull();
    expect(state.note).toBe("bounced to login");
  });

  it("re-checking a live session does not move `since`", () => {
    const first = live();
    const { state } = applyCheckResult(first, { nowMs: T0 + 4 * MIN, alive: true, note: "keepalive ok" });
    expect(state.sinceMs).toBe(T0);
    expect(state.checkedAtMs).toBe(T0 + 4 * MIN);
  });
});

// ── The keepalive ping ────────────────────────────────────────────────────

describe("the keepalive ping", () => {
  it("is due only after the interval, and only while alive", () => {
    const state = live();
    expect(tick(state, { nowMs: T0 + DEFAULT_KEEPALIVE_MS - 1 }).actions).not.toContain("keepalive-check");
    expect(tick(state, { nowMs: T0 + DEFAULT_KEEPALIVE_MS }).actions).toContain("keepalive-check");

    // A DEAD session is never pinged: `gotoAuthenticated` would re-submit
    // credentials and park on a QR page nobody asked for, every four minutes.
    const dead = applyCheckResult(state, { nowMs: T0 + HOUR, alive: false, note: "bounced to login" }).state;
    expect(tick(dead, { nowMs: T0 + 10 * HOUR }).actions).not.toContain("keepalive-check");
  });

  it("is blocked while a QR handoff owns the page", () => {
    const state = live();
    const actions = tick(state, { nowMs: T0 + HOUR, handoffInProgress: true }).actions;
    expect(actions).not.toContain("keepalive-check");
    expect(actions).not.toContain("run-queue");
  });
});

// ── Death, reported exactly once, with the right lifetime ────────────────

describe("a session that ends", () => {
  it("reports the death once, with `endedAt - since` as the lifetime", () => {
    // A KEEPALIVE lands between the login and the death, on purpose: in
    // production one lands every four minutes, so `checkedAt` and `since` are
    // never the same number by the time a session ends. Without it this test
    // passes for `endedAt - checkedAt` too — which would publish "อยู่ได้ 0 ชม.
    // 4 นาที" for an eight-hour session and destroy the one reading we get of
    // the bank's session cap.
    const state = applyCheckResult(live(), { nowMs: T0 + 5 * HOUR, alive: true, note: "keepalive ok" }).state;
    expect(state.checkedAtMs).not.toBe(state.sinceMs);
    const died = applyCheckResult(state, {
      nowMs: T0 + 5 * HOUR + 10 * MIN,
      alive: false,
      note: "bounced to login",
    });

    expect(died.actions).toEqual(["session-ended"]);
    expect(isAlive(died.state)).toBe(false);
    expect(died.state.endedAtMs).toBe(T0 + 5 * HOUR + 10 * MIN);
    expect(died.state.lastLifetimeMs).toBe(5 * HOUR + 10 * MIN);

    // Every later dead check is silent — one death, one line.
    const again = applyCheckResult(died.state, { nowMs: T0 + 6 * HOUR, alive: false, note: "bounced to login" });
    expect(again.actions).toEqual([]);
    expect(again.state.lastLifetimeMs).toBe(5 * HOUR + 10 * MIN);
    expect(again.state.endedAtMs).toBe(T0 + 5 * HOUR + 10 * MIN);
  });

  it("re-arms the report for the NEXT session", () => {
    const died = applyCheckResult(live(), { nowMs: T0 + HOUR, alive: false, note: "dead" }).state;
    const reborn = applyCheckResult(died, { nowMs: T0 + 2 * HOUR, alive: true, note: "logged in" }).state;
    expect(reborn.sinceMs).toBe(T0 + 2 * HOUR);
    // The previous session's lifetime survives as the published instrument…
    expect(reborn.lastLifetimeMs).toBe(HOUR);
    // …and this session's own death is announced when it comes.
    const second = applyCheckResult(reborn, { nowMs: T0 + 3 * HOUR, alive: false, note: "dead" });
    expect(second.actions).toEqual(["session-ended"]);
    expect(second.state.lastLifetimeMs).toBe(HOUR);
  });

  it("renders the lifetime the contract's way", () => {
    expect(formatSessionLifetime(5 * HOUR + 10 * MIN)).toBe("5 ชม. 10 นาที");
    expect(formatSessionLifetime(40 * MIN)).toBe("0 ชม. 40 นาที");
    expect(formatSessionLifetime(null)).toBe("ไม่ทราบระยะเวลา");
    expect(keeperSlackLine("session-ended", { pageUrl: PAGE_URL, lifetimeMs: 5 * HOUR + 10 * MIN })).toBe(
      sessionEndedMessage({ lifetimeMs: 5 * HOUR + 10 * MIN, pageUrl: PAGE_URL }),
    );
    // …against the literal, not just against itself: this is the line the
    // operator reads most often and the one carrying the session-cap number.
    expect(sessionEndedMessage({ lifetimeMs: 5 * HOUR + 10 * MIN, pageUrl: PAGE_URL })).toBe(
      `:warning: kbiz-bot: เซสชัน K BIZ หมดอายุแล้ว (อยู่ได้ 5 ชม. 10 นาที) — ` +
        `เมื่อมีจอที่สองแล้ว เปิด ${PAGE_URL} แล้วกด "เข้าสู่ระบบ K BIZ"`,
    );
  });
});

// ── A failure that proves nothing ────────────────────────────────────────

describe("a check that fails with none of the contract's death signals", () => {
  /** A bank outage, a network failure, a context that went away mid-navigation
   *  — the driver classifies (isSessionDeathError) and flags these. */
  const blip = (state: KeeperState, nowMs: number) =>
    applyCheckResult(state, { nowMs, alive: false, unclassified: true, note: "check failed: bank timeout" });

  it("is a blip, not a death — until it repeats", () => {
    let folded = blip(live(), T0 + 5 * MIN);
    expect(folded.actions).toEqual([]);
    expect(isAlive(folded.state)).toBe(true);
    expect(folded.state.sinceMs).toBe(T0);
    expect(folded.state.endedAtMs).toBeNull();
    expect(folded.state.lastLifetimeMs).toBeNull();
    // `checkedAt` IS stamped: the retry comes at the next keepalive, not 5 s
    // later, so a bank that is down is asked once every four minutes.
    expect(folded.state.checkedAtMs).toBe(T0 + 5 * MIN);
    expect(folded.state.note).toBe("check failed: bank timeout");

    folded = blip(folded.state, T0 + 9 * MIN);
    expect(folded.actions).toEqual([]);
    expect(isAlive(folded.state)).toBe(true);

    // The third in a row IS a death — and the lifetime is still measured from
    // `since`, not from the first blip.
    folded = blip(folded.state, T0 + 13 * MIN);
    expect(folded.actions).toEqual(["session-ended"]);
    expect(isAlive(folded.state)).toBe(false);
    expect(folded.state.lastLifetimeMs).toBe(13 * MIN);
    expect(UNCLASSIFIED_FAILURE_LIMIT).toBe(3);
  });

  it("forgets the blips as soon as one check succeeds", () => {
    let state = blip(live(), T0 + 5 * MIN).state;
    state = blip(state, T0 + 9 * MIN).state;
    state = applyCheckResult(state, { nowMs: T0 + 13 * MIN, alive: true, note: "keepalive ok" }).state;
    expect(state.consecutiveUnclassifiedFailures).toBe(0);
    // …so a later blip starts counting again from one, instead of being the
    // third of a run that ended half an hour ago.
    expect(isAlive(blip(state, T0 + 40 * MIN).state)).toBe(true);
  });

  it("keeps pinging the session it refused to bury", () => {
    // The consequence that matters: decideTick only emits `keepalive-check`
    // while alive, so a session buried by a transient blip would never be
    // re-checked — it would sit dead until a human pressed the button.
    const state = blip(live(), T0 + 5 * MIN).state;
    expect(tick(state, { nowMs: T0 + 5 * MIN + DEFAULT_KEEPALIVE_MS }).actions).toContain("keepalive-check");
  });

  it("never delays a CLASSIFIED death", () => {
    // QrLoginRequiredError and "still bouncing" are proof, and proof ends the
    // session on the first check, exactly as the contract says.
    const died = applyCheckResult(live(), { nowMs: T0 + HOUR, alive: false, note: "bounced to login" });
    expect(died.actions).toEqual(["session-ended"]);
    expect(died.state.lastLifetimeMs).toBe(HOUR);
  });
});

// ── The operator's button ────────────────────────────────────────────────

describe("the operator's login request", () => {
  it("is the ONLY thing that starts a login, and it owns the whole tick", () => {
    const dead = initialKeeperState();
    const { actions } = tick(dead, { requestPresent: true, approvedCount: 3, nowMs: bkk("2026-09-17", "09:00") });
    // No nudge, no reminder, no queue run alongside it: the operator has just
    // pressed the button, and "press the button" is the only thing those lines
    // have to say.
    expect(actions).toEqual(["claim-and-login"]);
  });

  it("never starts a second login while one is running", () => {
    const { actions } = tick(initialKeeperState(), { requestPresent: true, handoffInProgress: true });
    expect(actions).not.toContain("claim-and-login");
  });

  it("is still honoured on a session we believe is alive (the page says so)", () => {
    // An operator who presses the button on a live session gets the
    // "ยังใช้งานได้" line, not a QR — but the request must still be CLAIMED, or
    // the file sits on disk forever and the page never leaves "กำลังเตรียม QR…".
    expect(tick(live(), { requestPresent: true }).actions).toEqual(["claim-and-login"]);
    expect(sessionAliveMessage()).toBe(":white_check_mark: kbiz-bot: เซสชัน K BIZ ยังใช้งานได้ ไม่ต้องสแกน");
  });
});

// ── The queue step ───────────────────────────────────────────────────────

describe("the queue step", () => {
  it("keeps its own 30 s cadence, alive or dead", () => {
    // Never-run is always due (the first tick of a fresh process polls at once,
    // exactly like the old watch loop's immediate first pass).
    expect(tick(live()).actions).toContain("run-queue");

    const state = markQueueRan(live(), T0);
    expect(tick(state, { nowMs: T0 + DEFAULT_QUEUE_POLL_MS - 1 }).actions).not.toContain("run-queue");

    const due = tick(state, { nowMs: T0 + DEFAULT_QUEUE_POLL_MS });
    expect(due.actions).toContain("run-queue");
    // Stamped at decision time so a throw cannot spin, and again on completion
    // (markQueueRan) so a batch that waited minutes for a phone tap does not
    // re-poll the instant it returns.
    expect(due.state.lastQueueAtMs).toBe(T0 + DEFAULT_QUEUE_POLL_MS);
    const ran = markQueueRan(due.state, T0 + 5 * MIN);
    expect(tick(ran, { nowMs: T0 + 5 * MIN + 1_000 }).actions).not.toContain("run-queue");

    // Dead is not a reason to skip it: the count it reads is what the nudge
    // names, and nothing in it touches the bank while dead.
    const dead = markQueueRan(initialKeeperState(), T0);
    expect(tick(dead, { nowMs: T0 + HOUR }).actions).toContain("run-queue");
  });
});

// ── The "work is waiting" nudge ──────────────────────────────────────────

describe("the work-waiting nudge", () => {
  const dead = () => applyCheckResult(live(), { nowMs: T0, alive: false, note: "dead" }).state;

  it("fires on a changed count and then at most hourly", () => {
    let state = markQueueRan(dead(), T0);
    const first = tick(state, { nowMs: T0 + MIN, approvedCount: 2 });
    expect(first.actions).toContain("nudge");
    state = first.state;

    // Same count, minutes later: silence.
    expect(tick(state, { nowMs: T0 + 10 * MIN, approvedCount: 2 }).actions).not.toContain("nudge");
    expect(tick(state, { nowMs: T0 + MIN + NUDGE_INTERVAL_MS - 1, approvedCount: 2 }).actions).not.toContain("nudge");

    // An hour later, still waiting: one more line.
    expect(tick(state, { nowMs: T0 + MIN + NUDGE_INTERVAL_MS, approvedCount: 2 }).actions).toContain("nudge");

    // A CHANGED count is news and goes out at once.
    expect(tick(state, { nowMs: T0 + 2 * MIN, approvedCount: 3 }).actions).toContain("nudge");
  });

  it("says nothing with no work, and nothing at all while alive", () => {
    expect(tick(dead(), { nowMs: T0 + MIN, approvedCount: 0 }).actions).not.toContain("nudge");
    expect(tick(live(), { nowMs: T0 + HOUR, approvedCount: 5 }).actions).not.toContain("nudge");
  });

  it("names the count the contract's way", () => {
    expect(keeperSlackLine("nudge", { pageUrl: PAGE_URL, pending: 2 })).toBe(
      workWaitingMessage({ count: 2, pageUrl: PAGE_URL }),
    );
    expect(workWaitingMessage({ count: 2, pageUrl: PAGE_URL })).toBe(
      `:hourglass: kbiz-bot: มี 2 งานรอ K BIZ — เปิด ${PAGE_URL} แล้วกด "เข้าสู่ระบบ K BIZ"`,
    );
  });
});

// ── The morning reminder ─────────────────────────────────────────────────

describe("the 08:30 Bangkok reminder", () => {
  const dead = () => markQueueRan(initialKeeperState(), T0);

  it("fires once per Bangkok day, only while dead, only from 08:30", () => {
    let state = dead();
    expect(tick(state, { nowMs: bkk("2026-09-17", "08:29") }).actions).not.toContain("reminder");

    const fired = tick(state, { nowMs: bkk("2026-09-17", "08:30") });
    expect(fired.actions).toContain("reminder");
    state = fired.state;

    // Not again, all day.
    expect(tick(state, { nowMs: bkk("2026-09-17", "08:35") }).actions).not.toContain("reminder");
    expect(tick(state, { nowMs: bkk("2026-09-17", "23:59") }).actions).not.toContain("reminder");

    // Tomorrow, still dead: once more.
    expect(tick(state, { nowMs: bkk("2026-09-18", "08:30") }).actions).toContain("reminder");
  });

  it("stays quiet while the session is alive", () => {
    expect(tick(live(), { nowMs: bkk("2026-09-17", "09:00") }).actions).not.toContain("reminder");
  });

  it("does the Bangkok day boundary with a fixed +7, not the host's zone", () => {
    // 17:00 UTC is already the NEXT Bangkok day (00:00 +07). A host running in
    // UTC and one running in Asia/Bangkok must reminder on the same calendar
    // days, so the arithmetic may never touch the local zone.
    expect(bangkokDay(Date.parse("2026-09-17T16:59:59.000Z"))).toBe("2026-09-17");
    expect(bangkokDay(Date.parse("2026-09-17T17:00:00.000Z"))).toBe("2026-09-18");
    expect(bangkokMinuteOfDay(Date.parse("2026-09-17T01:30:00.000Z"))).toBe(8 * 60 + 30);
    expect(parseReminderHhmm(DEFAULT_REMINDER_HHMM)).toBe(510);
  });

  it("refuses a malformed override rather than nagging at midnight", () => {
    for (const bad of ["", "8h30", "24:00", "08:60", "abc", undefined, null]) {
      expect(parseReminderHhmm(bad as string | undefined)).toBeNull();
    }
    const off = { ...defaultKeeperConfig(), reminderMinuteOfDay: null };
    expect(decideTick(dead(), {
      nowMs: bkk("2026-09-17", "12:00"),
      alive: false,
      requestPresent: false,
      handoffInProgress: false,
      approvedCount: 0,
      browserOpen: true,
    }, off).actions).not.toContain("reminder");
  });

  it("uses the contract's line", () => {
    expect(keeperSlackLine("reminder", { pageUrl: PAGE_URL })).toBe(loginReminderMessage({ pageUrl: PAGE_URL }));
    expect(loginReminderMessage({ pageUrl: PAGE_URL })).toBe(
      `:sunrise: kbiz-bot: เซสชัน K BIZ ยังไม่ได้เข้าสู่ระบบ — เปิด ${PAGE_URL} แล้วกด "เข้าสู่ระบบ K BIZ"`,
    );
  });
});

// ── A restart that missed the morning ────────────────────────────────────

describe("the reminder across restarts", () => {
  it("seeds the day, so a 14:00 redeploy posts no sunrise line", () => {
    // `lastReminderDay` is in-memory only. Without the seed, every restart on a
    // logged-out day re-posts ":sunrise: … ยังไม่ได้เข้าสู่ระบบ" at whatever
    // hour the container happened to come up.
    const seeded = seedReminderDay(initialKeeperState(), bkk("2026-09-17", "14:00"), config);
    expect(tick(seeded, { nowMs: bkk("2026-09-17", "14:00") }).actions).not.toContain("reminder");
    // …and the next morning still reminds.
    expect(tick(seeded, { nowMs: bkk("2026-09-18", "08:30") }).actions).toContain("reminder");
  });

  it("leaves a process that started BEFORE the reminder alone", () => {
    const seeded = seedReminderDay(initialKeeperState(), bkk("2026-09-17", "07:00"), config);
    expect(seeded.lastReminderDay).toBeNull();
    expect(tick(seeded, { nowMs: bkk("2026-09-17", "08:30") }).actions).toContain("reminder");
  });

  it("is a MORNING line: it fires in a window past 08:30 and nowhere else", () => {
    // A session that dies in the evening gets the "งานรอ" nudge; a sunrise
    // emoji at 20:00 is how an operator learns to ignore the one line whose
    // whole value is that it means "it is morning".
    const state = markQueueRan(initialKeeperState(), T0);
    expect(tick(state, { nowMs: bkk("2026-09-17", "09:29") }).actions).toContain("reminder");
    expect(tick(state, { nowMs: bkk("2026-09-17", "09:30") }).actions).not.toContain("reminder");
    expect(tick(state, { nowMs: bkk("2026-09-17", "20:00") }).actions).not.toContain("reminder");
    expect(tick(state, { nowMs: bkk("2026-09-17", "23:00") }).actions).not.toContain("reminder");
  });
});

// ── A browser that went away ─────────────────────────────────────────────

describe("a closed or crashed context", () => {
  it("reopens first, then re-checks a session it believed was alive", () => {
    const { actions } = tick(live(), { nowMs: T0 + MIN, browserOpen: false });
    expect(actions).toEqual(["reopen-browser", "keepalive-check"]);
  });

  it("reopens WITHOUT a check when the session was already dead", () => {
    // Cookies live in the profile volume, so a reopened context often still
    // holds a live session — but checking a session we know is dead would only
    // re-submit credentials to earn a QR nobody requested.
    const { actions } = tick(initialKeeperState(), { nowMs: T0 + MIN, browserOpen: false });
    expect(actions).toEqual(["reopen-browser"]);
  });

  it("backs off instead of relaunching Chromium every tick", () => {
    // A launch can fail for a reason 5 s will not fix — a profile lock held by
    // a stray `npm run login`, no disk, no /dev/shm — and the driver's throw
    // used to land straight back in the loop: a Chromium launch 12×/min,
    // indefinitely.
    const first = tick(initialKeeperState(), { nowMs: T0, browserOpen: false });
    expect(first.actions).toEqual(["reopen-browser"]);
    expect(first.state.lastReopenAtMs).toBe(T0);

    const failed = markReopened(first.state, false);
    expect(tick(failed, { nowMs: T0 + config.tickMs, browserOpen: false }).actions).toEqual([]);
    expect(tick(failed, { nowMs: T0 + 2 * config.tickMs, browserOpen: false }).actions).toEqual(["reopen-browser"]);

    // One tick, then 2, 4, 8 … capped at the keepalive interval.
    expect(reopenBackoffMs(0, config)).toBe(config.tickMs);
    expect(reopenBackoffMs(2, config)).toBe(4 * config.tickMs);
    expect(reopenBackoffMs(10, config)).toBe(config.keepaliveMs);

    // A launch that worked clears it.
    expect(markReopened(failed, true).reopenFailures).toBe(0);
  });

  it("does nothing else that tick — not even a login request", () => {
    const { actions } = tick(initialKeeperState(), {
      nowMs: bkk("2026-09-17", "09:00"),
      browserOpen: false,
      requestPresent: true,
      approvedCount: 4,
    });
    expect(actions).toEqual(["reopen-browser"]);
  });
});

// ── session.json ─────────────────────────────────────────────────────────

describe("session.json", () => {
  it("publishes exactly the contract's fields", () => {
    let state = live();
    state = setPending(state, 2);
    expect(sessionFileFrom(state)).toEqual({
      alive: true,
      since: new Date(T0).toISOString(),
      checkedAt: new Date(T0).toISOString(),
      endedAt: null,
      lastLifetimeMs: null,
      pending: 2,
      note: "keepalive ok",
    });

    const died = applyCheckResult(state, { nowMs: T0 + 5 * HOUR + 10 * MIN, alive: false, note: "bounced to login" });
    expect(sessionFileFrom(died.state)).toEqual({
      alive: false,
      since: null,
      checkedAt: new Date(T0 + 5 * HOUR + 10 * MIN).toISOString(),
      endedAt: new Date(T0 + 5 * HOUR + 10 * MIN).toISOString(),
      lastLifetimeMs: 5 * HOUR + 10 * MIN,
      pending: 2,
      note: "bounced to login",
    });
  });

  it("carries a note with no check behind it", () => {
    expect(sessionFileFrom(withNote(live(), "browser restarted")).note).toBe("browser restarted");
  });

  it("never publishes a negative or fractional pending count", () => {
    expect(sessionFileFrom(setPending(live(), -3)).pending).toBe(0);
    expect(sessionFileFrom(setPending(live(), 2.7)).pending).toBe(2);
  });
});

// ── Clock hygiene ────────────────────────────────────────────────────────

describe("a clock that misbehaves", () => {
  it("re-opens the keepalive and the queue when time jumps BACKWARDS", () => {
    // A stamp in the future would otherwise wedge both cadences until real
    // time caught up — minutes or hours of a silent, idle bot.
    const state = markQueueRan(live(T0 + HOUR), T0 + HOUR);
    const { actions } = tick(state, { nowMs: T0 });
    expect(actions).toContain("keepalive-check");
    expect(actions).toContain("run-queue");
  });

  it("keeps the nudge quiet on a backwards clock (silence is the safe way)", () => {
    let state = applyCheckResult(live(), { nowMs: T0, alive: false, note: "dead" }).state;
    state = markQueueRan(state, T0);
    state = tick(state, { nowMs: T0 + HOUR, approvedCount: 2 }).state;
    expect(tick(state, { nowMs: T0, approvedCount: 2 }).actions).not.toContain("nudge");
  });

  it("never lets a bad env override turn a cadence into a tight loop", () => {
    expect(DEFAULT_TICK_MS).toBe(5_000);
    expect(DEFAULT_KEEPALIVE_MS).toBe(240_000);
    expect(DEFAULT_QUEUE_POLL_MS).toBe(30_000);
  });
});

// ── The split root CI depends on ─────────────────────────────────────────

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe("no playwright import (root CI runs bun test before kbiz-bot's node_modules exist)", () => {
  it("session-keeper-core.ts imports nothing from playwright, and no fs", () => {
    const src = readFileSync(at("../src/lib/session-keeper-core.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']playwright["']/);
    expect(src).not.toMatch(/from\s+["']node:fs["']/);
    // …and it decides nothing about money.
    expect(src).not.toContain("arm-lock");
    expect(src).not.toContain("transfer");
  });

  it("the driver half is the only one that touches the browser", () => {
    const driver = readFileSync(at("../src/lib/session-keeper.ts"), "utf8");
    expect(driver).toMatch(/from\s+["']playwright["']/);
    // The driver holds no policy: every cadence and rate limit is next door.
    expect(driver).not.toContain("KEEPALIVE_MS");
    expect(driver).not.toContain("decideTick");
    // It DOES classify, because only it sees the exception: a bank blip must
    // not reach the reducer looking like the bank's own death signals.
    expect(driver).toContain("isSessionDeathError");
    // …and every note it publishes is masked (session.json is served on a
    // Cloudflare-gated page, and bank errors carry `loginQR.do?cmd=<token>`).
    expect(driver).toContain("maskedNote");
  });

  it("installs no signal handler that would fight playwright's own", () => {
    // Playwright closes the browser on SIGTERM/SIGINT (docker stop); a second
    // handler racing it for the same context is how a profile lock survives a
    // restart and the next launch fails.
    for (const rel of ["../src/lib/session-keeper.ts", "../src/lib/session.ts", "../src/process-queue.ts"]) {
      expect(readFileSync(at(rel), "utf8")).not.toMatch(/process\.on\(\s*["']SIG/);
    }
  });
});

describe("the tick order the contract fixes", () => {
  it("is trigger → keepalive → queue → nudge → reminder", () => {
    // One tick where EVERYTHING is due at once, on a dead session with work
    // waiting, past 08:30 Bangkok. The order is the contract's, and the driver
    // executes the array in order.
    const state = applyCheckResult(live(), { nowMs: T0, alive: false, note: "dead" }).state;
    const all: KeeperAction[] = tick(state, {
      nowMs: bkk("2026-09-17", "09:00"),
      approvedCount: 2,
    }).actions;
    expect(all).toEqual(["run-queue", "nudge", "reminder"]);

    // …and with a request pending, the login pre-empts all of it.
    expect(tick(state, { nowMs: bkk("2026-09-17", "09:00"), approvedCount: 2, requestPresent: true }).actions).toEqual([
      "claim-and-login",
    ]);
  });

  it("puts the keepalive before the queue on a live session", () => {
    const state = markQueueRan(live(), T0);
    expect(tick(state, { nowMs: T0 + HOUR }).actions).toEqual(["keepalive-check", "run-queue"]);
  });
});
