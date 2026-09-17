/**
 * Playwright-free `QrLoginView` stub with a virtual clock — the same shape as
 * stub-approval-page.ts, for the same reason: `runQrHandoff`'s full 6.5-min
 * deadline then runs in microseconds and deterministically. Must not import
 * "playwright" (root CI runs `bun test` before kbiz-bot's node_modules exist).
 *
 * The clock advances ONLY inside `sleep()`. Nothing else may move it: a test
 * that could nudge time from a read would stop proving the loop's cadence.
 */

import type { QrLoginState, QrLoginView } from "../../src/lib/qr-login-core";

const QR_URL = "https://kbiz.kasikornbank.com/authen/loginQR.do?cmd=stub";
const LOGIN_URL = "https://kbiz.kasikornbank.com/authen/login.jsp?lang=th";
const DASHBOARD_URL = "https://kbiz.kasikornbank.com/menu/account/account-summary";

export const STUB_QR_URL = QR_URL;
export const STUB_LOGIN_URL = LOGIN_URL;
export const STUB_DASHBOARD_URL = DASHBOARD_URL;

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

export function stubQrView(
  frames: QrStubFrame[],
  opts?: { confirmDashboard?: boolean | ((t: number) => boolean) },
): QrStubView {
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  let t = 0;
  const pngs: Uint8Array[] = [];
  const states: QrLoginState[] = [];
  const notes: string[] = [];
  let removals = 0;
  let dashboardChecks = 0;

  /** The latest frame with atMs <= t, or undefined before the first frame. */
  const latestFrame = (): QrStubFrame | undefined => {
    let latest: QrStubFrame | undefined;
    for (const f of sorted) {
      if (f.atMs <= t) latest = f;
      else break;
    }
    return latest;
  };

  const confirm = opts?.confirmDashboard ?? true;

  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    url: () => latestFrame()?.url ?? QR_URL,
    qrDataUri: async () => latestFrame()?.qrDataUri ?? null,
    loginFormVisible: async () => latestFrame()?.loginFormVisible ?? false,
    confirmDashboard: async () => {
      dashboardChecks++;
      return typeof confirm === "function" ? confirm(t) : confirm;
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
    elapsed: () => t,
    pngWrites: () => pngs,
    states: () => states,
    pngRemovals: () => removals,
    notifications: () => notes,
    dashboardChecks: () => dashboardChecks,
  };
}
