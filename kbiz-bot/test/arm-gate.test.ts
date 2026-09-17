// The one-push-at-a-time decision logic, plus the two historical incidents
// replayed as regression scenarios.
//
// Everything here is pure + virtual-clock: a 6.5-minute bank window and a
// 10.5-minute conservative hold both replay in microseconds, and nothing
// touches a browser, the disk or the queue. `bun test` from the repo root runs
// this file BEFORE kbiz-bot/node_modules exists — no playwright, not even
// transitively (arm-gate.ts's only flows import is `import type`, erased).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  armedLock,
  conservativeLock,
  CONSERVATIVE_TOTAL_MS,
  decideArm,
  deferredErrorText,
  deferredMessage,
  livePushWarning,
  parseArmLock,
  releasedLock,
  TAP_COOLDOWN_MS,
  UNCONFIRMED_DEFER_MS,
  type ArmLock,
  type DeferCode,
  type LockView,
  type PrevMoneyItem,
} from "../src/lib/arm-gate";
import { PUSH_LIFETIME_MS } from "../src/lib/approval-wait";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// 2026-08-19: this used to be a local mirror of process-queue.ts's own
// constant, pinned only by a structural grep. It is now imported directly —
// TAP_COOLDOWN_MS is the real cooldown length, exported from arm-gate.ts and
// spent by BOTH the in-batch row and the cross-poll released-lock rows.
const INTER_TRANSFER_GAP_MS = TAP_COOLDOWN_MS;

const T0 = Date.parse("2026-08-14T01:20:00.000Z");
const NO_LOCK: LockView = { live: false, source: "none" };

// ───────────────────────────────────────────────────────────────────────────
// D2 truth table
// ───────────────────────────────────────────────────────────────────────────

describe("decideArm — the D2 truth table", () => {
  const decide = (prev: PrevMoneyItem, lock: LockView = NO_LOCK) =>
    decideArm({ prev, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS });

  it("first money item of a batch, no lock → arms with no gap", () => {
    expect(decide({ kind: "none" })).toEqual({ kind: "arm", gapMs: 0 });
  });

  it("previous item failed BEFORE arming → arms with no gap (a payee typo must not hold the batch)", () => {
    // The 90 s pause exists to let the K BIZ app background itself between two
    // real pushes. If nothing was armed there is nothing to background, and
    // charging the next item 90 s protects nothing.
    expect(decide({ kind: "not-armed", id: "pi_a" })).toEqual({ kind: "arm", gapMs: 0 });
  });

  it("previous item armed and SUCCEEDED → arms after the inter-transfer gap", () => {
    expect(decide({ kind: "armed", id: "pi_a", outcome: "success" })).toEqual({
      kind: "arm",
      gapMs: INTER_TRANSFER_GAP_MS,
    });
  });

  it("previous item armed and the bank REJECTED it → defers (prev-confirmed-failed)", () => {
    expect(decide({ kind: "armed", id: "pi_a", outcome: "confirmed-failed" })).toEqual({
      kind: "defer",
      code: "prev-confirmed-failed",
      prevId: "pi_a",
    });
  });

  it("previous item armed and never confirmed → defers (prev-unconfirmed)", () => {
    // Bank confirmation IS the operator ack. Anything short of it hands the
    // batch back to the human instead of arming into the dark.
    expect(decide({ kind: "armed", id: "pi_a", outcome: "unconfirmed" })).toEqual({
      kind: "defer",
      code: "prev-unconfirmed",
      prevId: "pi_a",
    });
  });

  it("a LIVE lock defers regardless of the previous item — including the first item of a batch", () => {
    const live: LockView = { live: true, until: T0 + 200_000, source: "parsed", armedAt: T0 - 190_000 };
    for (const prev of [
      { kind: "none" } as PrevMoneyItem,
      { kind: "not-armed", id: "pi_a" } as PrevMoneyItem,
      { kind: "armed", id: "pi_a", outcome: "success" } as PrevMoneyItem,
    ]) {
      const d = decideArm({ prev, lock: live, now: T0, gapMs: INTER_TRANSFER_GAP_MS });
      expect(d).toMatchObject({ kind: "defer", code: "push-may-be-live", until: T0 + 200_000 });
    }
  });

  it("checks the lock FIRST — a live lock outranks the previous item's outcome", () => {
    const live: LockView = { live: true, until: T0 + 60_000, source: "parsed" };
    expect(
      decideArm({ prev: { kind: "armed", id: "pi_a", outcome: "unconfirmed" }, lock: live, now: T0, gapMs: 0 }),
    ).toMatchObject({ code: "push-may-be-live" });
  });

  // ── NEW rows, 2026-08-19: push-expired joins success as an "arm after the
  // gap" outcome (§2.6 — a voided push most likely means the operator was
  // sitting inside K BIZ, so they need the pause more than anyone), and the
  // released lock itself now carries a previous poll's tap across the batch
  // boundary that `prev` cannot survive (the 2026-08-18 cross-poll hole).

  it("previous item armed and the bank VOIDED it (push-expired) → arms after the same gap as a success", () => {
    expect(decide({ kind: "armed", id: "pi_a", outcome: "push-expired" })).toEqual({
      kind: "arm",
      gapMs: INTER_TRANSFER_GAP_MS,
    });
  });

  it("cross-poll: a released SUCCESS 30 s ago → arms after the REMAINDER of the gap, not the full gap", () => {
    const lock: LockView = { live: false, source: "released", releasedAt: T0 - 30_000, resolution: "success", intentId: "pi_a" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 60_000,
    });
  });

  it("cross-poll: a released SUCCESS 120 s ago (past the gap) → arms with no gap", () => {
    const lock: LockView = { live: false, source: "released", releasedAt: T0 - 120_000, resolution: "success", intentId: "pi_a" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });
  });

  it("cross-poll: a released UNCONFIRMED 60 s ago → defers, naming the previous id and WHEN it is safe again", () => {
    const releasedAt = T0 - 60_000;
    const lock: LockView = { live: false, source: "released", releasedAt, resolution: "unconfirmed", intentId: "pi_a" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "defer",
      code: "prev-unconfirmed",
      prevId: "pi_a",
      until: releasedAt + UNCONFIRMED_DEFER_MS,
    });
  });

  it("cross-poll: a released UNCONFIRMED 400 s ago (past its own ~6.5 min window) → arms with no gap", () => {
    // 400 s > UNCONFIRMED_DEFER_MS (390 s) AND > the 90 s tap cooldown, so this
    // also exercises the "age >= bound" fallback, not just the defer window.
    const lock: LockView = { live: false, source: "released", releasedAt: T0 - 400_000, resolution: "unconfirmed", intentId: "pi_a" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });
  });

  it("cross-poll: a released lock that never armed anything (pre-arm abort) → arms immediately, no tax", () => {
    // "never-armed" means there was never a push to background from — see the
    // in-batch not-armed row above for the same reasoning.
    const lock: LockView = { live: false, source: "released", releasedAt: T0 - 1_000, resolution: "never-armed", intentId: "pi_a" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });
  });

  it("cross-poll BACK-COMPAT: a released lock with no releasedAt (written by the currently deployed build) → arms with no gap", () => {
    // The two images in this estate do not roll out atomically — a lock the
    // OLD build wrote carries neither `releasedAt` nor `resolution`. Treating
    // that as "nothing to go on" and falling back to today's gap-0 behaviour
    // is mandatory, not a shortcut: the alternative is misreading an unrelated
    // field as a stale age and holding the estate on bad data.
    const lock: LockView = { live: false, source: "released" };
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parseArmLock
// ───────────────────────────────────────────────────────────────────────────

describe("parseArmLock", () => {
  it("no file → not live", () => {
    expect(parseArmLock(null, null, T0)).toEqual({ live: false, source: "none" });
  });

  it("an armed lock is live strictly BEFORE pushExpiresAt, and dead AT it", () => {
    // Boundary pinned deliberately: at exactly pushExpiresAt the bank's window
    // has elapsed, so the push is dead and the next item may arm. An inclusive
    // comparison here would add an unbounded off-by-one to every hold.
    const text = JSON.stringify(armedLock("pi_a", T0));
    const expiry = T0 + PUSH_LIFETIME_MS;
    expect(parseArmLock(text, T0, expiry - 1)).toEqual({ live: true, until: expiry, source: "parsed", armedAt: T0 });
    expect(parseArmLock(text, T0, expiry)).toEqual({ live: false, source: "expired" });
    expect(parseArmLock(text, T0, expiry + 1)).toEqual({ live: false, source: "expired" });
  });

  it("a released lock is not live even inside the window — and now SURFACES releasedAt/resolution/intentId", () => {
    // 2026-08-19: these three used to be thrown away here (the exact bug the
    // cross-poll gate closes). Still `live: false, source: "released"` —
    // meaning preserved — but the caller can now compute an age from it.
    const text = JSON.stringify(releasedLock(armedLock("pi_a", T0), "success", T0 + 8_000));
    expect(parseArmLock(text, T0, T0 + 9_000)).toEqual({
      live: false,
      source: "released",
      releasedAt: T0 + 8_000,
      resolution: "success",
      intentId: "pi_a",
    });
  });

  it("a released lock with a GARBAGE updatedAt falls back to the file's mtime — NOT to undefined (money review finding 5, 2026-08-19)", () => {
    // A release write interrupted mid-flight can leave `updatedAt` truncated
    // while `state`/`resolution` survive intact — the exact 2026-08-18 arming
    // pattern this fallback exists to keep closed. `mtimeMs` is a perfectly
    // good stand-in for "when was this release written": `writeArmLock`
    // stamps the JSON body and the file's mtime in the same rename(2), so the
    // gate must not throw the age away just because ONE field failed to
    // parse — that used to turn OFF the entire cross-poll cooldown, including
    // the `unconfirmed` defer, and arm at gap 0.
    const releaseTime = T0 + 8_000;
    const garbage = JSON.stringify({ ...releasedLock(armedLock("pi_a", T0), "unconfirmed", releaseTime), updatedAt: "not a date" });
    const view = parseArmLock(garbage, releaseTime, releaseTime + 9_000);
    expect(view).toMatchObject({ live: false, source: "released", releasedAt: releaseTime, resolution: "unconfirmed" });
    // And decideArm actually uses it: an unconfirmed release 9s ago must
    // still defer, exactly as if updatedAt had parsed cleanly.
    expect(
      decideArm({ prev: { kind: "none" }, lock: view, now: releaseTime + 9_000, gapMs: INTER_TRANSFER_GAP_MS }),
    ).toMatchObject({ kind: "defer", code: "prev-unconfirmed" });
  });

  it("a released lock with a garbage updatedAt AND no mtime at all → releasedAt IS undefined (true back-compat floor), gate falls back to gap 0", () => {
    // The one case that should still degrade all the way: nothing at all to
    // derive an age from (a read that lost the stat too, per arm-lock.ts's
    // readArmLockRaw — text and mtime are read independently and either can
    // fail alone).
    const garbage = JSON.stringify({ ...releasedLock(armedLock("pi_a", T0), "unconfirmed", T0 + 8_000), updatedAt: "not a date" });
    const view = parseArmLock(garbage, null, T0 + 9_000);
    expect(view).toMatchObject({ live: false, source: "released", releasedAt: undefined });
    expect(decideArm({ prev: { kind: "none" }, lock: view, now: T0 + 9_000, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });
  });

  it("MONEY REVIEW FINDING 9: a releasedAt in the FUTURE (clock skew) clamps age to 0, not a negative — never overshoots gapMs", () => {
    const lock: LockView = { live: false, source: "released", releasedAt: T0 + 5_000, resolution: "success", intentId: "pi_a" };
    // now < releasedAt ⇒ a naive `now - releasedAt` is negative, which would
    // make `gapMs - age` LARGER than gapMs (fail-open in the "hold too long,
    // then eventually overflow setTimeout and fire instantly" direction).
    expect(decideArm({ prev: { kind: "none" }, lock, now: T0, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: INTER_TRANSFER_GAP_MS,
    });
  });

  it("a lock for a DIFFERENT intent still blocks — the lock is estate-global, not per-item", () => {
    // One phone, one bank-side push. Whose transfer armed it is irrelevant.
    const text = JSON.stringify(armedLock("pi_someone_else", T0));
    expect(parseArmLock(text, T0, T0 + 1_000).live).toBe(true);
  });

  it("corrupt text WITH an mtime → live until mtime + 10.5 min, then expired", () => {
    // A half-written or hand-edited lock must never read as a licence to arm.
    const mtime = T0;
    expect(parseArmLock('{"intentId":"pi_a","arme', mtime, T0 + 1_000)).toEqual({
      live: true,
      until: mtime + CONSERVATIVE_TOTAL_MS,
      source: "corrupt-mtime",
    });
    expect(parseArmLock("not json at all", mtime, mtime + CONSERVATIVE_TOTAL_MS)).toEqual({
      live: false,
      source: "expired",
    });
  });

  it("well-formed JSON of the WRONG shape is corrupt, not 'no lock'", () => {
    expect(parseArmLock('{"hello":"world"}', T0, T0 + 1_000)).toMatchObject({ live: true, source: "corrupt-mtime" });
    expect(parseArmLock('{"state":"armed"}', T0, T0 + 1_000)).toMatchObject({ live: true, source: "corrupt-mtime" });
  });

  it("an unparseable pushExpiresAt falls back to the mtime bound", () => {
    const text = JSON.stringify({ ...armedLock("pi_a", T0), pushExpiresAt: "whenever" });
    expect(parseArmLock(text, T0, T0 + 1_000)).toMatchObject({ live: true, source: "corrupt-mtime" });
  });

  it("corrupt text with NO mtime → not live, flagged corrupt-unknown for a loud warning", () => {
    // Nothing left to bound a hold with. Bounded either way: a corrupt file can
    // never wedge the bot permanently — but this is the state a human looks at.
    expect(parseArmLock("garbage", null, T0)).toEqual({ live: false, source: "corrupt-unknown" });
  });

  it("F5 — an UNREADABLE file (text null) that DOES have an mtime is corrupt, not 'no lock'", () => {
    // readArmLockRaw's readFileSync catches every errno, not just ENOENT: a
    // present-but-unreadable file (EACCES after a restart under a different
    // UID, a transient read error, …) still gets a real mtime back from the
    // separate statSync call. Treating that as "none" would arm straight on
    // top of a lock we simply couldn't read the bytes of — the fail-open gap
    // this case exists to close. It must take the same mtime-bound hold as
    // corrupt JSON.
    expect(parseArmLock(null, T0, T0 + 1_000)).toEqual({
      live: true,
      until: T0 + CONSERVATIVE_TOTAL_MS,
      source: "corrupt-mtime",
    });
    // Bounded, same as any other corrupt lock: expires at mtime + 10.5 min.
    expect(parseArmLock(null, T0, T0 + CONSERVATIVE_TOTAL_MS)).toEqual({ live: false, source: "expired" });
  });

  it("a TRULY missing file (text null, mtime null) is still 'none' — the common case is unaffected", () => {
    expect(parseArmLock(null, null, T0)).toEqual({ live: false, source: "none" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Lock records
// ───────────────────────────────────────────────────────────────────────────

describe("lock records", () => {
  it("the conservative lock covers pre-arm form-filling plus the whole push lifetime", () => {
    const lock = conservativeLock("pi_a", T0);
    expect(lock.state).toBe("armed");
    expect(Date.parse(lock.pushExpiresAt) - T0).toBe(CONSERVATIVE_TOTAL_MS);
    expect(CONSERVATIVE_TOTAL_MS).toBe(4 * 60_000 + PUSH_LIFETIME_MS);
  });

  it("the armed refinement narrows the window to the real 6.5 min from the click", () => {
    const lock = armedLock("pi_a", T0);
    expect(Date.parse(lock.pushExpiresAt) - T0).toBe(PUSH_LIFETIME_MS);
    // Strictly shorter than the conservative guess — refining can only ever
    // shorten a hold, never extend it.
    expect(Date.parse(lock.pushExpiresAt)).toBeLessThan(Date.parse(conservativeLock("pi_a", T0).pushExpiresAt));
  });

  it("releasing keeps the record and stamps how it ended", () => {
    const armed = armedLock("pi_a", T0);
    const rel = releasedLock(armed, "unconfirmed", T0 + 390_000);
    expect(rel).toMatchObject({ intentId: "pi_a", state: "released", resolution: "unconfirmed", armedAt: armed.armedAt });
    expect(rel.updatedAt).toBe(new Date(T0 + 390_000).toISOString());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Operator-facing text
// ───────────────────────────────────────────────────────────────────────────

describe("deferred messages", () => {
  const DEST = 'favorite "พี่วิว" (SCB …7394)'; // already masked by describeDestination
  const FULL_ACCOUNT = "1234567394";

  const held = (code: DeferCode, extra: Record<string, unknown> = {}) =>
    ({ kind: "defer" as const, code, ...extra }) as Extract<ReturnType<typeof decideArm>, { kind: "defer" }>;

  it("every queue-file error text starts with HELD:", () => {
    // reimbursement stores this verbatim as bundle.paymentError and shows it to
    // the approver next to a Retry button. "HELD" is the word that has to
    // survive being skim-read.
    for (const code of ["push-may-be-live", "prev-unconfirmed", "prev-confirmed-failed"] as DeferCode[]) {
      expect(deferredErrorText(held(code, { until: T0 + 252_000, prevId: "pi_a" }), T0)).toStartWith("HELD: ");
    }
  });

  it("the push-may-be-live text carries the arm time, the expiry and how long is left", () => {
    const armedAt = Date.parse("2026-08-14T01:24:31.000Z");
    const until = armedAt + 390_000; // 01:31:01Z
    const text = deferredErrorText(held("push-may-be-live", { until, armedAt }), until - 252_000);
    expect(text).toContain("01:24:31Z");
    expect(text).toContain("01:31:01Z");
    expect(text).toContain("≈4m12s");
    expect(text).toContain("nothing was submitted");
  });

  it("names the item, the batch position, the amount and the MASKED destination — never a full account number", () => {
    const msg = deferredMessage({
      id: "pi_b",
      dest: DEST,
      amount: 580,
      position: { position: 2, total: 2 },
      decision: held("prev-unconfirmed", { prevId: "pi_a" }),
      now: T0,
    });
    expect(msg).toContain("HELD");
    expect(msg).toContain("`pi_b`");
    expect(msg).toContain("transfer 2/2");
    expect(msg).toContain("฿580.00");
    expect(msg).toContain(DEST);
    expect(msg).toContain("`pi_a`");
    expect(msg).toContain("NOT started, nothing submitted");
    expect(msg).not.toContain(FULL_ACCOUNT);
  });

  it("works for a payroll item, which has no single amount to name", () => {
    const msg = deferredMessage({
      id: "payroll_1",
      dest: "transfer-payroll",
      decision: held("push-may-be-live", { until: T0 + 60_000, armedAt: T0 - 330_000 }),
      now: T0,
    });
    expect(msg).toContain("`payroll_1`");
    expect(msg).toContain("transfer-payroll");
    expect(msg).not.toContain("฿");
    expect(msg).toContain("Do NOT");
  });

  it("the prev-confirmed-failed line says the bank rejected it, not that we timed out", () => {
    const msg = deferredMessage({
      id: "pi_b",
      dest: DEST,
      amount: 12.5,
      decision: held("prev-confirmed-failed", { prevId: "pi_a" }),
      now: T0,
    });
    expect(msg).toContain("KBIZ rejected the previous transfer");
    expect(msg).toContain("back to approved");
  });

  it("livePushWarning tells the operator to close it out, NOT to retry", () => {
    // A live push tapped now is a real, resolvable payment — the danger is
    // paying AGAIN on top of it.
    const w = livePushWarning(Date.parse("2026-08-14T01:31:01.000Z"));
    expect(w).toContain("01:31:01Z");
    expect(w).toContain("MAY STILL BE LIVE");
    expect(w).toContain("Do NOT hit Retry");
    expect(w).toContain("โอนแล้ว");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Batch simulator — mirrors process-queue.ts's loop for the parts arm-gate owns
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the flow did. `pre-arm-failure` never clicked Next (bad payee handle,
 * ceiling, a picker throw); `armed` clicked it and came back; `crash-after-arm`
 * clicked it and threw.
 */
type SimRun =
  | { kind: "pre-arm-failure" }
  | { kind: "armed"; outcome: "success" | "confirmed-failed" | "unconfirmed"; pushMayBeLive: boolean; durationMs: number }
  | { kind: "crash-after-arm"; durationMs: number };

type SimItem = { id: string; type: "transfer-other" | "transfer-payroll"; run: SimRun };

type SimStep =
  | { id: string; action: "arm"; gapMs: number; at: number }
  | { id: string; action: "defer"; code: DeferCode; until?: number; at: number };

type LockWrite = { at: number; intentId: string; state: ArmLock["state"] };

function lockWorld(startMs: number) {
  let now = startMs;
  let text: string | null = null;
  let mtimeMs: number | null = null;
  const writes: LockWrite[] = [];
  return {
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    read() {
      return { text, mtimeMs };
    },
    write(lock: ArmLock) {
      text = JSON.stringify(lock);
      mtimeMs = now;
      writes.push({ at: now, intentId: lock.intentId, state: lock.state });
    },
    writes,
  };
}

/**
 * The batch loop of process-queue.ts, restated over the pure gate: read the
 * lock → decideArm → (defer, `prev` untouched) or (arm: spend the gap, take
 * the conservative lock, run, refine on the click, release ONLY when the push
 * is provably dead, update `prev`).
 *
 * `runs` counts how many times the flow was actually entered — the "spy on the
 * injected runner" assertion in the design's R2: a deferred item must never
 * reach a page, a form or a Next click.
 */
function simulateBatch(items: SimItem[], world: ReturnType<typeof lockWorld>) {
  let prev: PrevMoneyItem = { kind: "none" };
  const steps: SimStep[] = [];
  let runs = 0;

  for (const item of items) {
    const now = world.now;
    const { text, mtimeMs } = world.read();
    const decision = decideArm({ prev, lock: parseArmLock(text, mtimeMs, now), now, gapMs: INTER_TRANSFER_GAP_MS });

    if (decision.kind === "defer") {
      steps.push({ id: item.id, action: "defer", code: decision.code, until: decision.until, at: now });
      continue; // prev is NOT updated — a deferred item armed nothing
    }

    steps.push({ id: item.id, action: "arm", gapMs: decision.gapMs, at: now });
    world.advance(decision.gapMs);

    const acquired = conservativeLock(item.id, world.now);
    world.write(acquired);
    runs += 1;

    if (item.run.kind === "pre-arm-failure") {
      world.write(releasedLock(acquired, "never-armed", world.now));
      prev = { kind: "not-armed", id: item.id };
      continue;
    }

    const armedAt = world.now;
    world.write(armedLock(item.id, armedAt)); // the onArmed refinement
    world.advance(item.run.durationMs);

    if (item.run.kind === "crash-after-arm") {
      // Deliberately NOT released: a crash cannot prove the push is dead.
      prev = { kind: "armed", id: item.id, outcome: "unconfirmed" };
      continue;
    }

    if (!item.run.pushMayBeLive) {
      world.write(releasedLock(armedLock(item.id, armedAt), item.run.outcome, world.now));
    }
    prev = { kind: "armed", id: item.id, outcome: item.run.outcome };
  }

  return { steps, runs, prev };
}

const money = (id: string, run: SimRun): SimItem => ({ id, type: "transfer-other", run });

/**
 * What `main` did before this change, kept as an executable statement of the
 * defect rather than a paragraph of prose: `moneyItemsArmed > 0 ? gap : 0`,
 * and then arm — no lock, no look at how the previous item ended. The R2/R3
 * tests below assert this legacy rule WOULD have armed the very item the new
 * gate holds, which is what "red on main" means for a module main never had.
 */
function legacyDecide(moneyItemsArmed: number): { kind: "arm"; gapMs: number } {
  return { kind: "arm", gapMs: moneyItemsArmed > 0 ? INTER_TRANSFER_GAP_MS : 0 };
}

describe("regression: the 2026-08-12 / 2026-08-13 incidents", () => {
  it("R1 — the pair as it happened: #1 succeeds, #2 arms after the gap and never confirms, #3 is held", () => {
    // Honest limit, stated in the design: confirmation-gating does not by
    // itself prevent the ORIGINAL incident (#2's push simply expired unseen).
    // What it does prevent is the batch marching on afterwards, and what this
    // pins is that the lock timeline never overlaps.
    const world = lockWorld(T0);
    const { steps, runs } = simulateBatch(
      [
        money("pi_1", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 }),
        money("pi_2", { kind: "armed", outcome: "unconfirmed", pushMayBeLive: false, durationMs: 390_000 }),
        money("pi_3", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 }),
      ],
      world,
    );

    expect(steps[0]).toMatchObject({ id: "pi_1", action: "arm", gapMs: 0 });
    expect(steps[1]).toMatchObject({ id: "pi_2", action: "arm", gapMs: INTER_TRANSFER_GAP_MS });
    // #2 timed out unconfirmed → #3 is HELD, not armed into the dark.
    expect(steps[2]).toMatchObject({ id: "pi_3", action: "defer", code: "prev-unconfirmed" });
    expect(runs).toBe(2);

    // The lock timeline never overlaps: pi_1 is released before pi_2 acquires.
    const pi1Release = world.writes.findIndex((w) => w.intentId === "pi_1" && w.state === "released");
    const pi2Acquire = world.writes.findIndex((w) => w.intentId === "pi_2");
    expect(pi1Release).toBeGreaterThanOrEqual(0);
    expect(pi1Release).toBeLessThan(pi2Acquire);
    expect(world.writes.some((w) => w.intentId === "pi_3")).toBe(false);
  });

  it("R2 — the unrecoverable variant: #1 dies with the push LIVE, so #2 is never even started", () => {
    // Today's code (before this change) arms #2 ninety seconds later: two live
    // pushes at the bank, one phone, no banner for the second.
    const world = lockWorld(T0);
    const { steps, runs } = simulateBatch(
      [
        money("pi_1", { kind: "armed", outcome: "unconfirmed", pushMayBeLive: true, durationMs: 12_000 }),
        money("pi_2", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 }),
      ],
      world,
    );

    expect(steps[0]).toMatchObject({ id: "pi_1", action: "arm" });
    expect(steps[1]).toMatchObject({ id: "pi_2", action: "defer", code: "push-may-be-live" });
    // The runner was entered exactly once — pi_2 never saw a page, a form or a
    // Next click.
    expect(runs).toBe(1);

    // Held TWICE over, independently: the lock is live AND the previous item
    // never confirmed. Remove either guard and the other still holds it.
    const armedAt = T0; // no gap before the first item
    expect(parseArmLock(world.read().text, world.read().mtimeMs, T0 + 12_000).live).toBe(true);
    expect(
      decideArm({
        prev: { kind: "armed", id: "pi_1", outcome: "unconfirmed" },
        lock: { live: false, source: "released" },
        now: T0 + 12_000,
        gapMs: INTER_TRANSFER_GAP_MS,
      }),
    ).toMatchObject({ kind: "defer", code: "prev-unconfirmed" });

    // The lock was never released, and it expires 6.5 min after the click.
    expect(world.writes.filter((w) => w.state === "released")).toHaveLength(0);
    expect(parseArmLock(world.read().text, world.read().mtimeMs, armedAt + PUSH_LIFETIME_MS).live).toBe(false);

    // RED ON MAIN: the old rule armed pi_2 ninety seconds later regardless.
    expect(legacyDecide(1)).toEqual({ kind: "arm", gapMs: INTER_TRANSFER_GAP_MS });
  });

  it("R3 — the retry race: a fresh intent 30 s later is HELD by the DURABLE lock, then arms once it expires", () => {
    // This is the double-pay path. `prev` is per-batch and resets on the next
    // poll, so only the on-disk lock can hold the operator's Retry.
    const world = lockWorld(T0);
    simulateBatch([money("pi_1", { kind: "armed", outcome: "unconfirmed", pushMayBeLive: true, durationMs: 12_000 })], world);
    const armedAt = T0;

    // Next poll, 30 s later — a brand-new batch, `prev` back to "none".
    world.advance(30_000);
    const retry = simulateBatch([money("pi_1r", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 })], world);
    expect(retry.steps[0]).toMatchObject({ id: "pi_1r", action: "defer", code: "push-may-be-live" });
    expect(retry.runs).toBe(0);

    const until = (retry.steps[0] as Extract<SimStep, { action: "defer" }>).until;
    expect(until).toBe(armedAt + PUSH_LIFETIME_MS);
    // The operator is told exactly when it is safe again.
    expect(
      deferredMessage({
        id: "pi_1r",
        dest: 'favorite "พี่วิว" (SCB …7394)',
        amount: 580,
        decision: { kind: "defer", code: "push-may-be-live", until, armedAt },
        now: world.now,
      }),
    ).toContain(`${new Date(until as number).toISOString().slice(11, 19)}Z`);

    // Past the expiry, the same intent arms normally — the hold is bounded,
    // never a deadlock.
    world.advance(PUSH_LIFETIME_MS);
    const after = simulateBatch([money("pi_1r", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 })], world);
    expect(after.steps[0]).toMatchObject({ id: "pi_1r", action: "arm", gapMs: 0 });
    expect(after.runs).toBe(1);

    // RED ON MAIN: the retry is the FIRST money item of its own batch, so the
    // old rule armed it with no gap and no lock — straight onto a live push.
    expect(legacyDecide(0)).toEqual({ kind: "arm", gapMs: 0 });
  });

  it("R4 — a pre-arm failure must NOT hold the batch: #2 arms immediately, no 90 s tax", () => {
    const world = lockWorld(T0);
    const { steps, runs } = simulateBatch(
      [
        money("pi_1", { kind: "pre-arm-failure" }),
        money("pi_2", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 }),
      ],
      world,
    );
    expect(steps[1]).toMatchObject({ id: "pi_2", action: "arm", gapMs: 0 });
    expect(runs).toBe(2);
    // No time was spent waiting between them beyond the flow itself.
    expect((steps[1] as Extract<SimStep, { action: "arm" }>).at).toBe(T0);
  });

  it("R6 — mixed batch: a transfer-payroll item is held behind a live transfer-other push", () => {
    // The comment this change corrects claimed payroll items arm no phone
    // push. They do (Confirm → waitForMobileConfirmation), so a mixed batch
    // could hold two live pushes at once.
    const world = lockWorld(T0);
    const { steps, runs } = simulateBatch(
      [
        money("pi_1", { kind: "armed", outcome: "unconfirmed", pushMayBeLive: true, durationMs: 12_000 }),
        { id: "payroll_1", type: "transfer-payroll", run: { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 5_000 } },
      ],
      world,
    );
    expect(steps[1]).toMatchObject({ id: "payroll_1", action: "defer", code: "push-may-be-live" });
    expect(runs).toBe(1);
  });

  it("a crash after the click holds everything after it for the full conservative window", () => {
    const world = lockWorld(T0);
    const { steps, runs } = simulateBatch(
      [
        money("pi_1", { kind: "crash-after-arm", durationMs: 3_000 }),
        money("pi_2", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 8_000 }),
      ],
      world,
    );
    expect(steps[1]).toMatchObject({ id: "pi_2", action: "defer", code: "push-may-be-live" });
    expect(runs).toBe(1);
    expect(world.writes.filter((w) => w.state === "released")).toHaveLength(0);
    // Bounded: the refined lock expires 6.5 min after the click.
    world.advance(PUSH_LIFETIME_MS);
    expect(simulateBatch([money("pi_3", { kind: "armed", outcome: "success", pushMayBeLive: false, durationMs: 1 })], world).runs).toBe(1);
  });

  it("THE CROSS-POLL HOLE — replays run B verbatim: A releases at 15:40:33.620Z, B's gate reads it at 15:41:04.423Z, prev:none", () => {
    // This is the headline red→green of the whole fix. 2026-08-18: A's tap
    // released the lock; B was a fresh, single-item poll, so `prev` had
    // already reset to {kind:"none"} (process-queue.ts:309) — the ONLY place
    // a tap-keyed cooldown could still come from was the released lock A had
    // just written, 30.8 s earlier. Before this change, parseArmLock's
    // `state === "released"` branch returned bare `{live:false,
    // source:"released"}` and threw the timestamp away, so decideArm's only
    // rule for prev:none was "arm gap 0" — B armed immediately, 30.8 s after
    // the operator's last tap, phone still inside K BIZ, no banner, ~6.5 min
    // later the bank voided it. That is this whole incident in one number.
    const releasedAtIso = "2026-08-18T15:40:33.620Z";
    const gateNowIso = "2026-08-18T15:41:04.423Z";
    const releasedAt = Date.parse(releasedAtIso);
    const now = Date.parse(gateNowIso);
    expect(now - releasedAt).toBe(30_803);

    // TODAY (main): the exact object literal the old parseArmLock produced.
    const legacyLockView: LockView = { live: false, source: "released" };
    expect(decideArm({ prev: { kind: "none" }, lock: legacyLockView, now, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 0,
    });

    // AFTER this change: the same on-disk bytes A actually wrote, run through
    // the real parseArmLock, then the real decideArm.
    const aLock = releasedLock(armedLock("pi_a", releasedAt - 5_000), "success", releasedAt);
    const fixedLockView = parseArmLock(JSON.stringify(aLock), releasedAt, now);
    expect(decideArm({ prev: { kind: "none" }, lock: fixedLockView, now, gapMs: INTER_TRANSFER_GAP_MS })).toEqual({
      kind: "arm",
      gapMs: 59_197, // 90_000 - 30_803 — the remainder of the 90 s cooldown B never got
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Structural guards — the simulator above is only honest if process-queue.ts
// really is wired this way, and none of it is importable here (process-queue
// pulls playwright for real). Read it as TEXT, like shared-resolution.test.ts.
// ───────────────────────────────────────────────────────────────────────────

describe("process-queue.ts wiring", () => {
  const src = readFileSync(at("../src/process-queue.ts"), "utf8");
  const armGateSrc = readFileSync(at("../src/lib/arm-gate.ts"), "utf8");

  it("still spends the same 90 s tap cooldown this file simulates", () => {
    // 2026-08-19: the constant moved OUT of process-queue.ts and into
    // arm-gate.ts as TAP_COOLDOWN_MS (§1.2) — it is now the one true cooldown
    // length for both the in-batch row and the cross-poll released-lock rows
    // (decideArm), so process-queue.ts must import it rather than declare its
    // own copy that could drift from the value arm-gate.ts actually uses.
    expect(armGateSrc).toContain("export const TAP_COOLDOWN_MS = 90_000;");
    expect(src).toContain("TAP_COOLDOWN_MS");
    expect(src).not.toContain("INTER_TRANSFER_GAP_MS");
  });

  it("evaluates the gate BEFORE claiming the item as running", () => {
    // A deferred item must never post ':hourglass: Running' or be marked
    // `running` — `running` is never auto-re-run, so a held item stamped
    // running would be stranded forever.
    const gate = src.indexOf("decideArm({");
    const claim = src.indexOf('status: "running"');
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(claim);
  });

  it("reads the durable lock in the gate and takes a conservative one before arming", () => {
    expect(src).toContain("readArmLockRaw()");
    // The two acquire sites — runTransferOtherQueueItem, and the shared
    // transfer-payroll / add-payroll branch — take the conservative lock
    // BEFORE their flow runs, and both fail closed on it.
    expect(src.match(/conservativeLock\(req\.id, Date\.now\(\)\)/g)).toHaveLength(2);
    expect(src.match(/refusing to arm\./g)).toHaveLength(2);
    // Re-pointed 2026-08-19 (kbiz-fix-spec.md §1.6/§2.3): the arm refinement
    // now stamps the CLICK time, not the moment the onArmed callback runs —
    // onArmed only fires after verifyArmed confirms the bank's "notification
    // sent" panel, which is deliberately later than the click, so the lock's
    // window must reflect when the push actually started counting down at
    // the bank, not when we finished confirming it exists.
    expect(src).toContain("writeArmLock(armedLock(req.id, armedAt))");
  });

  it("gates and locks EVERY push-arming type, add-payroll included", () => {
    // add-payroll arms a real push: its Next click makes KBIZ render the
    // "A notification has been sent to the K BIZ application" review screen
    // and the flow then sits in waitForMobileConfirmation for 5 min. It was
    // excluded from both the gate and the lock, which is a second live push
    // on the one phone. Only list-favorites / list-registered are push-free.
    const gateLine = src
      .split("\n")
      .find((l) => l.includes('req.type === "transfer-other"') && l.includes('req.type === "transfer-payroll"'));
    expect(gateLine).toBeDefined();
    expect(gateLine).toContain('req.type === "add-payroll"');

    // …and the acquire branch covers the same two payroll types.
    expect(src).toContain('if (req.type === "transfer-payroll" || req.type === "add-payroll")');
    // Release only on a provably dead outcome, exactly as the transfer-other
    // path does — a flow that cannot prove it says so with pushMayBeLive.
    expect(src).toContain("if (pushLock && !pushMayBeLive)");
  });

  it("NEVER releases the lock in the crash handler", () => {
    // The single most important line of this change that is an ABSENCE.
    const start = src.indexOf("// Unknown crash:");
    expect(start).toBeGreaterThan(-1);
    const crashBlock = src.slice(start, src.indexOf("continue;", start));
    expect(crashBlock).not.toContain("writeArmLock");
    expect(crashBlock).toContain("NOT RELEASED");
  });

  it("MONEY FINDING 1 — readPriorAttempts keeps EVERY sibling regardless of status, no terminal-only filter", () => {
    // 2026-08-19: this used to keep only terminal attempts (done/failed/
    // needs-review), which drops exactly the two statuses that most mean
    // "may have paid" — `running` (the flow is mid-tap right now, e.g. a
    // killed container never wrote a terminal status) and `approved`
    // (queued but not yet claimed). That let the SAME bundle's retry
    // auto-confirm KBIZ's duplicate popup with reason "no-prior-attempt" on
    // a popup the bank raised BECAUSE the earlier attempt actually moved
    // the money — a double-pay. Nothing else in this suite can reach
    // readPriorAttempts (process-queue.ts pulls playwright for real), so
    // the invariant is pinned here, structurally, exactly like the other
    // process-queue.ts wiring facts in this describe block. Re-adding
    // `if (status !== "done" && status !== "failed" && status !==
    // "needs-review") continue;` must fail this test.
    const start = src.indexOf("async function readPriorAttempts");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nasync function runTransferOtherQueueItem", start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).not.toMatch(/status\s*!==\s*"done"/);
    expect(fn).not.toMatch(/status\s*!==\s*"failed"/);
    expect(fn).not.toMatch(/status\s*!==\s*"needs-review"/);
    expect(fn).not.toMatch(/if\s*\(\s*status\b/);
    expect(fn).toContain("no status filter");
  });

  it("F4 — the payroll branch spends gapMs too, BEFORE the lock is acquired", () => {
    // The pause has to happen before the conservative lock so the 4-minute
    // pre-arm window doesn't start ticking during a 90 s wait that hasn't
    // armed anything yet — same ordering transfer-other uses (gap, THEN
    // arm-lock, THEN flow).
    // Indentation-insensitive: this pins the ORDERING, not the nesting depth
    // of the batch loop the block happens to sit in.
    const acquireIdx = src.search(
      /let pushLock: ArmLock \| undefined;\s*\n\s*if \(req\.type === "transfer-payroll" \|\| req\.type === "add-payroll"\) \{/,
    );
    expect(acquireIdx).toBeGreaterThan(-1);
    const branch = src.slice(acquireIdx, src.indexOf("const candidate = conservativeLock(req.id, Date.now());", acquireIdx));
    expect(branch).toContain("if (gapMs > 0)");
    expect(branch).toContain("pauseBeforeArmMessage(");
  });

  it("F4 — the payroll branch updates `prev` on both the normal return and the crash handler", () => {
    // Before this fix `prev` was only ever set in the transfer-other branch —
    // a money item following an armed payroll/add-payroll push saw stale
    // `prev = {kind:"none"}` and armed with gap 0, no warning.
    const tryIdx = src.indexOf("const pushMayBeLive = \"pushMayBeLive\" in result");
    expect(tryIdx).toBeGreaterThan(-1);
    const crashIdx = src.indexOf("// A transfer-payroll / add-payroll crash leaves its arm lock STANDING");
    expect(crashIdx).toBeGreaterThan(-1);
    const normalReturn = src.slice(tryIdx, crashIdx);
    expect(normalReturn).toContain('if (pushLock) {');
    expect(normalReturn).toContain('{ kind: "armed", id: req.id, outcome: "success" }');
    expect(normalReturn).toContain('{ kind: "not-armed", id: req.id }');

    // …up to the end of the batch. This used to anchor on the three closing
    // braces that ended the catch, the item loop and the `withSession`
    // callback; CR-2026-09-17 took the callback away (the resident keeper owns
    // the context and hands `processBatch` its page), so the block is pinned to
    // the function's own return instead — same invariant, one nesting level
    // less, and still indentation-insensitive.
    const crashEnd = src.indexOf("return approved.length;", crashIdx);
    expect(crashEnd).toBeGreaterThan(crashIdx);
    const crashBlock = src.slice(crashIdx, crashEnd);
    expect(crashBlock).toContain('if (pushLock) prev = { kind: "armed", id: req.id, outcome: "unconfirmed" };');
  });

  it("F7 — a deferred payroll item gets the {success:false} shape, not the transfer-other {outcome} shape", () => {
    // PayrollQueueRequest.result is typed {success: boolean; ...} and the
    // status view branches on `req.result.success` — the transfer-other
    // shape has no `success` key at all, so `undefined` used to fall to the
    // failure branch by JS coercion accident rather than a real false.
    const deferIdx = src.indexOf('if (decision.kind === "defer") {');
    expect(deferIdx).toBeGreaterThan(-1);
    const deferBlock = src.slice(deferIdx, src.indexOf("continue;", deferIdx));
    expect(deferBlock).toContain('req.type === "transfer-other"');
    expect(deferBlock).toContain('mapFlowOutcomeToPatch({ success: false, error: errorText })');
    expect(deferBlock).toContain('{ status: "failed" as const, result: { success: false as const, error: errorText } }');
  });
});

describe("the manual CLIs hold the same estate-wide lock", () => {
  // "One live push in the estate" is only true if the hand-run scripts write
  // the lock too — reading it is not enough. A CLI that arms without writing
  // leaves the container's 30 s watch loop seeing `{live:false}` and arming a
  // money push on top of a push that is still tappable on the same phone.
  const cases: Array<{ file: string; src: string }> = [
    { file: "transfer-other.ts", src: readFileSync(at("../src/transfer-other.ts"), "utf8") },
    { file: "transfer-payroll.ts", src: readFileSync(at("../src/transfer-payroll.ts"), "utf8") },
  ];

  for (const { file, src } of cases) {
    it(`${file} refuses under a live lock`, () => {
      expect(src).toContain("readArmLockRaw()");
      expect(src).toContain("parseArmLock(text, mtimeMs, now)");
      expect(src).toContain("refusing to arm a second one");
    });

    it(`${file} ACQUIRES the conservative lock before the session, failing closed`, () => {
      const acquire = src.indexOf("conservativeLock(");
      const session = src.indexOf("withSession(");
      expect(acquire).toBeGreaterThan(-1);
      expect(session).toBeGreaterThan(-1);
      expect(acquire).toBeLessThan(session);
      expect(src).toContain("refusing to arm.");
    });

    it(`${file} releases only on a provably dead outcome`, () => {
      expect(src).toContain("releasedLock(");
      expect(src).toContain("pushMayBeLive");
    });
  }

  it("transfer-other.ts leaves PREVIEW mode unlocked — it never clicks Next", () => {
    const src = cases[0].src;
    // Both the refusal and the acquire sit inside the same `if (confirm)`.
    const guard = src.indexOf("if (confirm) {");
    expect(guard).toBeGreaterThan(-1);
    expect(src.indexOf("conservativeLock(")).toBeGreaterThan(guard);
    expect(src.indexOf("conservativeLock(")).toBeLessThan(src.indexOf("// ── run ──"));
  });
});
