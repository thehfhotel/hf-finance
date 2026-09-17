import { afterAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KBIZ_QR_PNG_FILE,
  KBIZ_QR_ROUTES,
  KBIZ_QR_STATE_FILE,
  kbizLoginQrPageResponse,
  kbizLoginQrPngResponse,
  kbizLoginQrStateResponse,
  kbizQrDir,
  readKbizQrState,
} from "../src/kbiz-login-qr";

const UPDATED = "2026-09-17T04:05:06.000Z";
const NO_STORE = "private, no-store";
// `expiresAt` is read against the wall clock (a `waiting` past its deadline
// reads back as `expired`), so fixtures say which side of now they sit on.
// Both are frozen at module load, so every fixture in a run agrees.
const HOUR_MS = 3_600_000;
const FUTURE = new Date(Date.now() + HOUR_MS).toISOString();
const PAST = new Date(Date.now() - HOUR_MS).toISOString();
// Not a real QR — the routes never decode it, they only pass the bytes through.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const temporaryDirs: string[] = [];

const waitingState = () => ({
  status: "waiting",
  reason: "2 approved item(s)",
  attempt: 2,
  capturedAt: "2026-09-17T04:05:00.000Z",
  expiresAt: FUTURE,
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

// The handlers take no Request — they are the route bodies themselves, so the
// cases below call them directly and only the wiring case goes through Elysia.
const pageFor = (dir: string) => kbizLoginQrPageResponse({ dir });
const pngFor = (dir: string) => kbizLoginQrPngResponse({ dir });
const stateFor = (dir: string) => kbizLoginQrStateResponse({ dir });
const htmlFor = async (dir: string) => (await pageFor(dir)).text();
const stateBodyFor = async (dir: string) => (await stateFor(dir)).json();
const pngBytesFor = async (dir: string) => new Uint8Array(await (await pngFor(dir)).arrayBuffer());

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("kbiz login QR handoff routes", () => {
  it("serves an idle page, an idle state and no PNG before the bot ever publishes", async () => {
    const empty = await handoff();
    for (const dir of [empty, join(empty, "never-created")]) {
      const state = await stateFor(dir);
      expect(state.status).toBe(200);
      expect(state.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(state.headers.get("cache-control")).toBe(NO_STORE);
      expect(await state.json()).toEqual({ status: "idle" });

      const png = await pngFor(dir);
      expect(png.status).toBe(404);
      expect(png.headers.get("cache-control")).toBe(NO_STORE);

      const page = await pageFor(dir);
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

    const png = await pngFor(dir);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe(NO_STORE);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);

    const html = await htmlFor(dir);
    expect(html).toContain('data-status="waiting"');
    expect(html).toContain(`src="/kbiz/login-qr.png?t=${encodeURIComponent(UPDATED)}"`);
    expect(html).toContain("2 approved item(s)");
    expect(html).toContain("สแกน QR ด้านล่างด้วยแอป K BIZ ภายใน 5 นาที");
    // The poller gets both of its URLs from the boot blob, so the contract
    // paths are spelled server-side once and reach the client unchanged.
    expect(html).toContain('"routes":{"state":"/kbiz/login-qr/state.json","qrSrc":"/kbiz/login-qr.png?t="}');

    expect(await stateBodyFor(dir)).toEqual(waitingState());
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
      expect((await pngFor(dir)).status).toBe(404);
      const html = await htmlFor(dir);
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(copy);
      expect(html).not.toContain('src="/kbiz/login-qr.png?t=');
    }
  });

  it("reads a waiting publish whose deadline has passed back as expired", async () => {
    // Same crashed-publisher hazard as above, but the file still says
    // `waiting`: the QR behind it is dead, so nothing may offer it to scan.
    const stale = await handoff({ ...waitingState(), expiresAt: PAST }, { png: true });
    expect(await stateBodyFor(stale)).toEqual({ ...waitingState(), expiresAt: PAST, status: "expired" });
    expect((await pngFor(stale)).status).toBe(404);
    const staleHtml = await htmlFor(stale);
    expect(staleHtml).toContain('data-status="expired"');
    expect(staleHtml).toContain("QR หมดอายุแล้ว ระบบจะขอ QR ใหม่ให้อีกครั้ง");
    expect(staleHtml).not.toContain('src="/kbiz/login-qr.png?t=');

    // A deadline still ahead is left exactly as published.
    const live = await handoff({ ...waitingState(), expiresAt: FUTURE }, { png: true });
    expect(await stateBodyFor(live)).toEqual(waitingState());
    expect((await pngFor(live)).status).toBe(200);
    expect(await htmlFor(live)).toContain('data-status="waiting"');
  });

  it("reports a malformed or unrecognised publish as error, never as idle", async () => {
    for (const broken of ['{"status":"waiting"', "", "null", '"waiting"', "[]", '{"status":"idle"}',
      '{"status":"logged-in"}', '{"attempt":1}', '{"status":123}']) {
      const dir = await handoff(broken, { png: true });
      expect(await stateBodyFor(dir)).toEqual({ status: "error" });
      expect((await pngFor(dir)).status).toBe(404);
      const page = await pageFor(dir);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('data-status="error"');
    }
  });

  it("serves the same three responses however many other files sit in the handoff dir", async () => {
    const dir = await handoff(waitingState(), { png: true });
    const before = await htmlFor(dir);

    await writeFile(join(dir, "other.png"), new Uint8Array([9, 9, 9]));
    await writeFile(join(dir, "state.json.tmp"), '{"status":"error"}');
    await writeFile(join(dir, "secret.txt"), "SAMPLE NOT-FOR-SERVING");

    expect(await pngBytesFor(dir)).toEqual(PNG);
    expect(await stateBodyFor(dir)).toEqual(waitingState());
    const after = await htmlFor(dir);
    expect(after).toBe(before);
    expect(after).not.toContain("SAMPLE NOT-FOR-SERVING");
  });

  it("forwards only the contract's fields, dropping anything else the bot writes", async () => {
    const dir = await handoff({ ...waitingState(), accountNumber: "1234567890", note: "SAMPLE EXTRA" });
    const body = await stateBodyFor(dir);
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

  it("answers the contract's three paths behind a router, each with its own content type", async () => {
    const dir = await handoff(waitingState(), { png: true });
    const app = new Elysia()
      .get(KBIZ_QR_ROUTES.page, () => kbizLoginQrPageResponse({ dir }))
      .get(KBIZ_QR_ROUTES.png, () => kbizLoginQrPngResponse({ dir }))
      .get(KBIZ_QR_ROUTES.state, () => kbizLoginQrStateResponse({ dir }));

    // The literals are the CR-2026-09-17 contract — pinned here as text, not
    // read back out of the constants the routes were registered with.
    for (const [path, contentType] of [
      ["/kbiz/login-qr", "text/html; charset=utf-8"],
      ["/kbiz/login-qr.png", "image/png"],
      ["/kbiz/login-qr/state.json", "application/json; charset=utf-8"],
    ]) {
      const res = await app.handle(new Request(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(contentType);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
    }
    expect({ ...KBIZ_QR_ROUTES }).toEqual({
      page: "/kbiz/login-qr",
      png: "/kbiz/login-qr.png",
      state: "/kbiz/login-qr/state.json",
    });
  });

  it("wires all three routes into the app", async () => {
    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    for (const [route, handler] of [
      ["page", "kbizLoginQrPageResponse"],
      ["png", "kbizLoginQrPngResponse"],
      ["state", "kbizLoginQrStateResponse"],
    ]) {
      expect(index).toContain(`.get(KBIZ_QR_ROUTES.${route}, () => ${handler}())`);
    }
  });
});
