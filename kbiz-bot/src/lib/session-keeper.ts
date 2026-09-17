/**
 * The driver half of the resident K BIZ session.
 *
 * It owns exactly three things: the persistent Chromium context (opened once,
 * held for the process lifetime), the one Page every caller shares, and the
 * two bank round-trips the keeper makes — the refuse-policy keepalive check
 * and the operator-triggered QR login. Every DECISION lives next door in
 * session-keeper-core.ts (pure); nothing here knows about cadences, lifetimes,
 * Bangkok days or rate limits.
 *
 * Imports playwright, so nothing under test/ and no pure module may import
 * THIS file (root CI runs `bun test` without kbiz-bot's node_modules).
 *
 * NO SIGNAL HANDLERS. Playwright's default SIGTERM/SIGINT handling closes the
 * browser when `docker stop` arrives; a handler of ours would fight it for the
 * same context and could leave the profile's lock file behind.
 */

import type { Page } from "playwright";
import { closeSession, gotoAuthenticated, openSession, type KbizSession } from "./session";
import { runQrLoginHandoff } from "./qr-login";
import {
  isSessionDeathError,
  KBIZ_DASHBOARD_URL,
  maskedNote,
  QrLoginRequiredError,
  QrLoginTimeoutError,
} from "./qr-login-core";

/** What one bank round-trip told us. `note` is short, masked and goes straight
 *  into `session.json`. */
export interface KeeperCheckResult {
  alive: boolean;
  note: string;
  /** The bank is parked on `loginQR.do` — a human with a second screen is the
   *  only way forward from here. */
  qrRequired?: boolean;
  /** A handoff ran and nobody scanned in time. */
  timedOut?: boolean;
  /** The button was pressed on a session that was in fact still good. */
  alreadyAlive?: boolean;
  /** The check failed WITHOUT any of the contract's death signals — a bank
   *  outage, a network blip, a context that went away mid-navigation. Not a
   *  death: the reducer counts these and only declares one after a few in a
   *  row (session-keeper-core.ts, UNCLASSIFIED_FAILURE_LIMIT). */
  unclassified?: boolean;
}

/** Keep a bank error string short enough to read in `session.json`, and never
 *  let `loginQR.do?cmd=<token>` or a long digit run through it. One copy, in
 *  qr-login-core, because process-queue's warm-up hook publishes through the
 *  same field. */
const note = maskedNote;

export interface SessionKeeper {
  /** Open the context. Idempotent — a second call on an open keeper is a no-op. */
  open(): Promise<void>;
  /** Close it, swallowing a context that is already gone. */
  close(): Promise<void>;
  /** Close (if open) and open again — the crashed-browser recovery. */
  reopen(): Promise<void>;
  isOpen(): boolean;
  /** The shared page. Throws if the context is not open — a caller that got
   *  here without one has a wiring bug, not a bank problem. */
  page(): Page;
  /** Prove the session is still up. Never throws. */
  check(): Promise<KeeperCheckResult>;
  /** The operator pressed the button. Never throws. */
  login(reason: string): Promise<KeeperCheckResult>;
}

export function createSessionKeeper(): SessionKeeper {
  let session: KbizSession | null = null;
  // Playwright's third page state. A CRASHED renderer (OOM, a GPU fault)
  // leaves the browser connected and the page not closed, so `isContextGone`
  // cannot see it — yet every later navigation throws "Target crashed". Without
  // this flag those throws would be counted as unclassified failures, the
  // session declared dead, and nothing would ever reopen the context.
  let crashed = false;

  const keeper: SessionKeeper = {
    isOpen: () => session !== null && !crashed && !isContextGone(session),

    page() {
      if (!session) throw new Error("session keeper: the browser context is not open");
      return session.page;
    },

    async open() {
      if (session) return;
      session = await openSession();
      crashed = false;
      session.page.on("crash", () => {
        crashed = true;
      });
    },

    async close() {
      if (!session) return;
      const open = session;
      session = null;
      crashed = false;
      await closeSession(open);
    },

    async reopen() {
      await keeper.close();
      await keeper.open();
    },

    /**
     * The keepalive ping: navigate to the dashboard under the DEFAULT `refuse`
     * policy. Refuse is the whole point — if the bank wants a scan we want to
     * know that the session is dead, not summon a human nobody asked to
     * summon. `gotoAuthenticated` still re-submits credentials on its recovery
     * path, which is why the keeper only pings while it believes the session is
     * ALIVE: one credential submission at the moment of death, never a loop.
     */
    async check(): Promise<KeeperCheckResult> {
      try {
        await gotoAuthenticated(keeper.page(), KBIZ_DASHBOARD_URL);
        return { alive: true, note: "keepalive ok" };
      } catch (e) {
        if (e instanceof QrLoginRequiredError) {
          return { alive: false, note: "bounced to login", qrRequired: true };
        }
        // The bank is still bouncing us after a full re-login: dead, and the
        // contract's third death signal. Anything else is a blip until it
        // repeats — see `unclassified` above.
        if (isSessionDeathError(e)) {
          return { alive: false, note: note(`check failed: ${(e as Error).message}`) };
        }
        return { alive: false, unclassified: true, note: note(`check failed: ${(e as Error).message}`) };
      }
    },

    /**
     * The operator pressed "เข้าสู่ระบบ K BIZ".
     *
     * A refuse-policy check runs FIRST, for two reasons: it answers "was the
     * session actually fine?" honestly (the contract's "ยังใช้งานได้" line)
     * without publishing a QR nobody needs, and when it is not fine it leaves
     * the page parked on `loginQR.do` with a LIVE code already rendered — so
     * the handoff runs against that code instead of submitting credentials a
     * second time to earn a second one.
     */
    async login(reason: string): Promise<KeeperCheckResult> {
      const probe = await keeper.check();
      if (probe.alive) return { ...probe, note: "login requested, session already alive", alreadyAlive: true };

      try {
        if (probe.qrRequired) {
          // Already on the QR page: publish THIS code.
          await runQrLoginHandoff(keeper.page(), { reason });
        } else {
          // The probe failed for some other reason (a bank outage, a bounce we
          // could not classify). Go the long way round, with the handoff armed.
          await gotoAuthenticated(keeper.page(), KBIZ_DASHBOARD_URL, { onQr: "handoff", reason });
        }
        return { alive: true, note: "logged in by operator request" };
      } catch (e) {
        if (e instanceof QrLoginTimeoutError) {
          return { alive: false, note: "no scan before the deadline", timedOut: true };
        }
        // An operator-triggered login that fell over for an unclassified reason
        // leaves the session exactly as unknown as the probe found it — the
        // reducer must not book it as a death either.
        return {
          alive: false,
          unclassified: !isSessionDeathError(e),
          note: note(`login failed: ${(e as Error).message}`),
        };
      }
    },
  };

  return keeper;
}

/** A context whose browser died reports itself closed; treat that as "not
 *  open" so the tick asks for a reopen instead of driving a dead page. */
function isContextGone(session: KbizSession): boolean {
  const browser = session.ctx.browser();
  if (browser && !browser.isConnected()) return true;
  return session.page.isClosed();
}
