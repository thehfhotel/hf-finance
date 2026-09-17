import { afterAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KBIZ_QR_PNG_FILE,
  KBIZ_QR_STATE_FILE,
  kbizLoginQrPageResponse,
  kbizLoginQrPngResponse,
  kbizLoginQrStateResponse,
  kbizQrDir,
  readKbizQrState,
} from "../src/kbiz-login-qr";

const UPDATED = "2026-09-17T04:05:06.000Z";
const NO_STORE = "private, no-store";
// Not a real QR — the routes never decode it, they only pass the bytes through.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const temporaryDirs: string[] = [];

const waitingState = () => ({
  status: "waiting",
  reason: "2 approved item(s)",
  attempt: 2,
  capturedAt: "2026-09-17T04:05:00.000Z",
  expiresAt: "2026-09-17T04:10:55.000Z",
  updatedAt: UPDATED,
  message: "สแกนภายใน 5 นาที",
});

/** A fixture handoff dir. `state` is written verbatim when it is a string. */
async function handoff(state?: unknown, options: { png?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kbiz-qr-login-"));
  temporaryDirs.push(dir);
  if (state !== undefined) {
    await writeFile(join(dir, KBIZ_QR_STATE_FILE), typeof state === "string" ? state : JSON.stringify(state));
  }
  if (options.png) await writeFile(join(dir, KBIZ_QR_PNG_FILE), PNG);
  return dir;
}

function appFor(dir: string) {
  return new Elysia()
    .get("/kbiz/login-qr", () => kbizLoginQrPageResponse({ dir }))
    .get("/kbiz/login-qr.png", () => kbizLoginQrPngResponse({ dir }))
    .get("/kbiz/login-qr/state.json", () => kbizLoginQrStateResponse({ dir }));
}

const get = (dir: string, path: string) => appFor(dir).handle(new Request(`http://localhost${path}`));

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("kbiz login QR handoff routes", () => {
  it("serves an idle page, an idle state and no PNG before the bot ever publishes", async () => {
    const empty = await handoff();
    for (const dir of [empty, join(empty, "never-created")]) {
      const state = await get(dir, "/kbiz/login-qr/state.json");
      expect(state.status).toBe(200);
      expect(state.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(state.headers.get("cache-control")).toBe(NO_STORE);
      expect(await state.json()).toEqual({ status: "idle" });

      const png = await get(dir, "/kbiz/login-qr.png");
      expect(png.status).toBe(404);
      expect(png.headers.get("cache-control")).toBe(NO_STORE);

      const page = await get(dir, "/kbiz/login-qr");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control")).toBe(NO_STORE);
      const html = await page.text();
      expect(html).toContain("No scan pending.");
      expect(html).toContain("ยังไม่มีคำขอสแกนในขณะนี้");
      expect(html).toContain('data-status="idle"');
      expect(html).not.toContain('src="/kbiz/login-qr.png?t=');
    }
  });

  it("serves the PNG and shows it on the page while a scan is pending", async () => {
    const dir = await handoff(waitingState(), { png: true });

    const png = await get(dir, "/kbiz/login-qr.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe(NO_STORE);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);

    const html = await (await get(dir, "/kbiz/login-qr")).text();
    expect(html).toContain('data-status="waiting"');
    expect(html).toContain(`src="/kbiz/login-qr.png?t=${encodeURIComponent(UPDATED)}"`);
    expect(html).toContain("2 approved item(s)");
    expect(html).toContain("สแกน QR ด้านล่างด้วยแอป K BIZ ภายใน 5 นาที");

    expect(await (await get(dir, "/kbiz/login-qr/state.json")).json()).toEqual(waitingState());
  });

  it("renders the finished states and stops serving the image the moment it stops being scannable", async () => {
    const cases = [
      { status: "ok", copy: "เข้าสู่ระบบ K BIZ เรียบร้อยแล้ว ปิดหน้านี้ได้เลย" },
      { status: "expired", copy: "QR หมดอายุแล้ว ระบบจะขอ QR ใหม่ให้อีกครั้ง" },
      { status: "error", copy: "อ่านสถานะการเข้าสู่ระบบไม่ได้" },
    ];
    for (const { status, copy } of cases) {
      // The PNG is deliberately still on disk: a crashed publish must never
      // leave a stale QR being served as if it were live.
      const dir = await handoff({ ...waitingState(), status }, { png: true });
      expect((await get(dir, "/kbiz/login-qr.png")).status).toBe(404);
      const html = await (await get(dir, "/kbiz/login-qr")).text();
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(copy);
      expect(html).not.toContain('src="/kbiz/login-qr.png?t=');
    }
  });

  it("reports a malformed or unrecognised publish as error, never as idle", async () => {
    for (const broken of ['{"status":"waiting"', "", "null", '"waiting"', "[]", '{"status":"idle"}',
      '{"status":"logged-in"}', '{"attempt":1}', '{"status":123}']) {
      const dir = await handoff(broken, { png: true });
      expect(await (await get(dir, "/kbiz/login-qr/state.json")).json()).toEqual({ status: "error" });
      expect((await get(dir, "/kbiz/login-qr.png")).status).toBe(404);
      const page = await get(dir, "/kbiz/login-qr");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('data-status="error"');
    }
  });

  it("reads only the two contract filenames, whatever the request says", async () => {
    const dir = await handoff(waitingState(), { png: true });
    await writeFile(join(dir, "other.png"), new Uint8Array([9, 9, 9]));
    await writeFile(join(dir, "state.json.tmp"), '{"status":"error"}');
    await writeFile(join(dir, "secret.txt"), "SAMPLE NOT-FOR-SERVING");

    for (const path of ["/kbiz/login-qr.png?t=1", "/kbiz/login-qr.png?file=other.png",
      "/kbiz/login-qr.png?t=../secret.txt"]) {
      const png = await get(dir, path);
      expect(png.status).toBe(200);
      expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
    }
    for (const path of ["/kbiz/login-qr/state.json?file=secret.txt", "/kbiz/login-qr/state.json"]) {
      expect(await (await get(dir, path)).json()).toEqual(waitingState());
    }
    const html = await (await get(dir, "/kbiz/login-qr?file=secret.txt")).text();
    expect(html).not.toContain("SAMPLE NOT-FOR-SERVING");
  });

  it("forwards only the contract's fields, dropping anything else the bot writes", async () => {
    const dir = await handoff({ ...waitingState(), accountNumber: "1234567890", note: "SAMPLE EXTRA" });
    const body = await (await get(dir, "/kbiz/login-qr/state.json")).json();
    expect(body).toEqual(waitingState());
    const serialized = JSON.stringify(body);
    for (const dropped of ["accountNumber", "1234567890", "SAMPLE EXTRA"]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it("resolves the handoff dir per call, from KBIZ_QR_DIR, with the contract default", async () => {
    const previous = process.env.KBIZ_QR_DIR;
    try {
      delete process.env.KBIZ_QR_DIR;
      expect(kbizQrDir()).toBe("data/qr-login");
      const dir = await handoff(waitingState());
      process.env.KBIZ_QR_DIR = dir;
      expect(kbizQrDir()).toBe(dir);
      expect(await readKbizQrState()).toEqual(waitingState());
      expect(kbizQrDir("explicit/override")).toBe("explicit/override");
    } finally {
      if (previous === undefined) delete process.env.KBIZ_QR_DIR;
      else process.env.KBIZ_QR_DIR = previous;
    }
  });

  it("wires all three routes into the app", async () => {
    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    for (const [path, handler] of [
      ["/kbiz/login-qr", "kbizLoginQrPageResponse"],
      ["/kbiz/login-qr.png", "kbizLoginQrPngResponse"],
      ["/kbiz/login-qr/state.json", "kbizLoginQrStateResponse"],
    ]) {
      expect(index).toContain(`.get("${path}", () => ${handler}())`);
    }
  });
});
