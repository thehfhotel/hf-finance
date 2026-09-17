/**
 * Playwright-free `QrLoginView` stub on the shared virtual clock
 * (frame-clock.ts) — the same shape as stub-approval-page.ts, for the same
 * reason: `runQrHandoff`'s full 6.5-min deadline then runs in microseconds and
 * deterministically. Must not import "playwright" (root CI runs `bun test`
 * before kbiz-bot's node_modules exist).
 */

import { KBIZ_DASHBOARD_URL, type QrLoginState, type QrLoginView } from "../../src/lib/qr-login-core";
import { frameClock } from "./frame-clock";

export const STUB_QR_URL = "https://kbiz.kasikornbank.com/authen/loginQR.do?cmd=stub";
export const STUB_LOGIN_URL = "https://kbiz.kasikornbank.com/authen/login.jsp?lang=th";
/** The real constant, not a re-typed literal: a drift here would make the
 *  stub's "the bank redirected itself" frame a URL the core never sees. */
export const STUB_DASHBOARD_URL = KBIZ_DASHBOARD_URL;

/** A 1×1 PNG, base64 — real magic bytes, so decodeQrDataUri accepts it. */
export const PNG_1PX_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const pngDataUri = (b64: string = PNG_1PX_B64) => `data:image/png;base64,${b64}`;

export interface QrStubFrame {
  atMs: number;
  /** The page URL from this moment on. Defaults to the QR page. */
  url?: string;
  /** `img.qrcode`'s src from this moment on (null = no QR rendered). */
  qrDataUri?: string | null;
  /** Is the user/password form on screen from this moment on? */
  loginFormVisible?: boolean;
}

export interface QrStubView extends QrLoginView {
  elapsed(): number;
  pngWrites(): Uint8Array[];
  states(): QrLoginState[];
  pngRemovals(): number;
  notifications(): string[];
  dashboardChecks(): number;
}

export function stubQrView(frames: QrStubFrame[], opts?: { confirmDashboard?: boolean }): QrStubView {
  const clock = frameClock(frames);
  const pngs: Uint8Array[] = [];
  const states: QrLoginState[] = [];
  const notes: string[] = [];
  let removals = 0;
  let dashboardChecks = 0;

  const confirm = opts?.confirmDashboard ?? true;

  return {
    now: clock.now,
    sleep: clock.sleep,
    url: () => clock.latest()?.url ?? STUB_QR_URL,
    qrDataUri: async () => clock.latest()?.qrDataUri ?? null,
    loginFormVisible: async () => clock.latest()?.loginFormVisible ?? false,
    confirmDashboard: async () => {
      dashboardChecks++;
      return confirm;
    },
    writePng: async (bytes) => {
      pngs.push(bytes);
    },
    writeState: async (state) => {
      states.push(state);
    },
    removePng: async () => {
      removals++;
    },
    notify: async (text) => {
      notes.push(text);
    },
    elapsed: clock.now,
    pngWrites: () => pngs,
    states: () => states,
    pngRemovals: () => removals,
    notifications: () => notes,
    dashboardChecks: () => dashboardChecks,
  };
}
