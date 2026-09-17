/**
 * Playwright-free `ApprovalView` stub on the shared virtual clock
 * (frame-clock.ts), so `waitForApproval`'s full 6.5-min timeout runs in
 * microseconds and deterministically. Must not import "playwright" — root CI
 * runs `bun test` before kbiz-bot's node_modules exist.
 */

import type { ApprovalView } from "../../src/lib/approval-wait";
import { frameClock } from "./frame-clock";

export interface StubFrame {
  atMs: number;
  url?: string;
  text: string;
}

const DEFAULT_START_URL = "https://kbiz.kasikornbank.com/menu/fundtranfer/fundtranfer/fundtranfer-other";

export function stubApprovalView(
  frames: StubFrame[],
  opts?: { startUrl?: string },
): ApprovalView & { elapsed(): number; reads(): number } {
  const startUrl = opts?.startUrl ?? DEFAULT_START_URL;
  const clock = frameClock(frames);
  let readCount = 0;

  return {
    now: clock.now,
    url: () => clock.latest()?.url ?? startUrl,
    bodyText: async () => {
      readCount++;
      return clock.latest()?.text ?? "";
    },
    sleep: clock.sleep,
    elapsed: clock.now,
    reads: () => readCount,
  };
}
