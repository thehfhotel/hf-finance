/**
 * The virtual clock both page stubs run on: a sorted list of frames ("from
 * this moment on the page looks like THIS") plus a `t` that advances ONLY
 * inside `sleep()`. Nothing else may move it — a test that could nudge time
 * from a read would stop proving a loop's cadence — and because `sleep` is a
 * plain assignment, a full 6.5-min deadline resolves in microseconds and
 * deterministically.
 *
 * Playwright-free, like everything under test/: root CI runs `bun test`
 * before kbiz-bot's node_modules exist.
 */

export interface FrameClock<F extends { atMs: number }> {
  /** Virtual now, in ms since the loop started. */
  now(): number;
  /** Advance the clock. The only thing that does. */
  sleep(ms: number): Promise<void>;
  /** The latest frame with `atMs <= now()`, or undefined before the first. */
  latest(): F | undefined;
}

export function frameClock<F extends { atMs: number }>(frames: F[]): FrameClock<F> {
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    latest: () => {
      let latest: F | undefined;
      for (const f of sorted) {
        if (f.atMs <= t) latest = f;
        else break;
      }
      return latest;
    },
  };
}
