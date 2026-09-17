/**
 * The one atomic-write helper. `<path>.tmp` then rename(2) — atomic within a
 * filesystem, so a reader either sees the whole previous file or the whole new
 * one, never a truncated JSON object or a half-written PNG. Both readers this
 * repo has (payroll-form polls the QR publication every 5 s; arm-gate parses
 * the lock) treat a corrupt file as a real signal, so a partial write is never
 * harmless.
 *
 * THROWS on failure, deliberately — the arm lock's caller must fail closed
 * (no lock, no push), and the QR handoff would rather abort than claim a
 * publication it did not make.
 *
 * fs only, no playwright: root CI runs `bun test` before kbiz-bot's
 * node_modules exist.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
