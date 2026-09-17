import { afterAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KBIZ_LOGIN_REQUEST_FILE,
  KBIZ_QR_PNG_FILE,
  KBIZ_QR_ROUTES,
  KBIZ_QR_STATE_FILE,
  KBIZ_SESSION_FILE,
  kbizLoginQrPageResponse,
  kbizLoginQrPngResponse,
  kbizLoginQrStateResponse,
  kbizLoginRequestResponse,
  kbizQrDir,
  readKbizQrState,
} from "../src/kbiz-login-qr";
import { ACCESS_EMAIL_HEADER } from "../src/property-hint";

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

// The bot's session keeper writes this one on every check (CR-2026-09-17).
const sessionFile = (over: Record<string, unknown> = {}) => ({
  alive: true,
  since: "2026-09-17T02:00:00.000Z",
  checkedAt: "2026-09-17T04:00:00.000Z",
  endedAt: null,
  lastLifetimeMs: null,
  pending: 0,
  note: "keepalive ok",
  ...over,
});

/**
 * A fixture handoff dir. `state` is written verbatim when it is a string;
 * `session` / `request` are the two files the resident-session CR added.
 */
async function handoff(
  state?: unknown,
  options: { png?: boolean; session?: unknown; request?: unknown } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "kbiz-qr-login-"));
  temporaryDirs.push(dir);
  if (state !== undefined) {
    await writeFile(join(dir, KBIZ_QR_STATE_FILE), typeof state === "string" ? state : JSON.stringify(state));
  }
  if (options.png) await writeFile(join(dir, KBIZ_QR_PNG_FILE), PNG);
  for (const [file, body] of [
    [KBIZ_SESSION_FILE, options.session],
    [KBIZ_LOGIN_REQUEST_FILE, options.request],
  ] as const) {
    if (body === undefined) continue;
    await writeFile(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const requestFor = (dir: string, headers?: Record<string, string | undefined>) =>
  kbizLoginRequestResponse({ dir, headers });

const requestFileIn = async (dir: string) =>
  JSON.parse(await readFile(join(dir, KBIZ_LOGIN_REQUEST_FILE), "utf8"));

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
    expect(html).toContain(
      '"routes":{"state":"/kbiz/login-qr/state.json","qrSrc":"/kbiz/login-qr.png?t=","request":"/kbiz/login-qr/request"}'
    );

    expect(await stateBodyFor(dir)).toEqual(waitingState());
  });

  it("renders the finished states and stops serving the image the moment it stops being scannable", async () => {
    const cases = [
      { status: "ok", copy: "เข้าสู่ระบบ K BIZ เรียบร้อยแล้ว ปิดหน้านี้ได้เลย" },
      { status: "expired", copy: "QR หมดอายุแล้ว กดปุ่มด้านล่างเพื่อขอใหม่เมื่อพร้อม" },
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
    expect(staleHtml).toContain("QR หมดอายุแล้ว กดปุ่มด้านล่างเพื่อขอใหม่เมื่อพร้อม");
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
      request: "/kbiz/login-qr/request",
    });
  });

  it("wires all four routes into the app", async () => {
    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    for (const [route, handler] of [
      ["page", "kbizLoginQrPageResponse"],
      ["png", "kbizLoginQrPngResponse"],
      ["state", "kbizLoginQrStateResponse"],
    ]) {
      expect(index).toContain(`.get(KBIZ_QR_ROUTES.${route}, () => ${handler}())`);
    }
    // The POST is the only one that needs the request's headers — it records
    // who pressed the button — so the wiring must pass them through.
    expect(index).toContain(
      ".post(KBIZ_QR_ROUTES.request, ({ headers }) => kbizLoginRequestResponse({ headers }))"
    );
  });
});

// ---------------------------------------------------------------------------
// CR-2026-09-17 (resident session): the bot never logs in by itself any more.
// The operator's button writes `login.request`; `session.json` says whether
// there is anything to ask for.
// ---------------------------------------------------------------------------

describe("kbiz login request (the operator's button)", () => {
  it("writes the contract's request file atomically and accepts it", async () => {
    const dir = await handoff();
    const before = Date.now();
    const res = await requestFor(dir, { [ACCESS_EMAIL_HEADER]: "sample-operator@example.com" });

    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ accepted: true });

    const written = await requestFileIn(dir);
    expect(Object.keys(written).sort()).toEqual(["by", "requestedAt"]);
    expect(written.by).toBe("sample-operator@example.com");
    expect(Date.parse(written.requestedAt)).toBeGreaterThanOrEqual(before);
    // tmp + rename: the bot must never be able to read a half-written request.
    expect(await readdir(dir)).toEqual([KBIZ_LOGIN_REQUEST_FILE]);
  });

  it("records 'unknown' rather than junk when Access sends no usable identity", async () => {
    const junk = [
      undefined,
      "",
      "   ",
      "a@b\ncom",
      `${"x".repeat(250)}@example.com`,
      // Slack renders `<url|label>` as a clickable link with the attacker's
      // own text, and the bot echoes `by` into its Slack line — so anything
      // that is not plainly an email address never leaves this app.
      "<https://evil.example|ok@x.com>",
      "ok@x.com|https://evil.example",
      'say "hi"@example.com',
      "no-at-sign",
    ];
    for (const header of junk) {
      const dir = await handoff();
      const res = await requestFor(dir, header === undefined ? {} : { [ACCESS_EMAIL_HEADER]: header });
      expect(res.status).toBe(202);
      expect((await requestFileIn(dir)).by).toBe("unknown");
    }
    // No header bag at all (a direct call) is the same "we do not know".
    const bare = await handoff();
    expect((await kbizLoginRequestResponse({ dir: bare })).status).toBe(202);
    expect((await requestFileIn(bare)).by).toBe("unknown");
  });

  it("writes one whole request even when many presses land at once", async () => {
    // A single shared `login.request.tmp` is NOT an atomic write: concurrent
    // POSTs (two operator tabs, or one page firing twice) open the same tmp
    // with O_TRUNC and write from offset 0, so the rename can publish a
    // mixture of two payloads. Different-length identities make any splice
    // visible; a fresh dir per round keeps every call past the `already` gate.
    const senders = Array.from({ length: 24 }, (_, i) => `${"o".repeat(i + 1)}@example.com`);
    for (let round = 0; round < 5; round += 1) {
      const dir = await handoff();
      const answers = await Promise.all(senders.map((by) => requestFor(dir, { [ACCESS_EMAIL_HEADER]: by })));
      for (const answer of answers) expect(answer.status).toBe(202);

      // Whatever landed must be exactly ONE of the payloads, parseable, with
      // no tmp file left beside it.
      const written = await requestFileIn(dir);
      expect(Object.keys(written).sort()).toEqual(["by", "requestedAt"]);
      expect(senders).toContain(written.by);
      expect(Number.isFinite(Date.parse(written.requestedAt))).toBe(true);
      expect(await readdir(dir)).toEqual([KBIZ_LOGIN_REQUEST_FILE]);
    }
  });

  it("answers 'already' without rewriting a request the bot may be acting on", async () => {
    const existing = { requestedAt: "2026-09-17T03:00:00.000Z", by: "sample-operator@example.com" };
    const dir = await handoff(undefined, { request: existing });
    const res = await requestFor(dir, { [ACCESS_EMAIL_HEADER]: "someone-else@example.com" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, already: true });
    expect(await requestFileIn(dir)).toEqual(existing);
  });

  it("refuses while a live QR is already on screen, and accepts once it goes stale", async () => {
    const showing = await handoff(waitingState(), { png: true });
    const refused = await requestFor(showing, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "qr-already-showing" });
    expect(await readdir(showing)).not.toContain(KBIZ_LOGIN_REQUEST_FILE);

    // A `waiting` past its deadline is not a QR anyone can scan, so asking for
    // a fresh login is exactly right.
    const stale = await handoff({ ...waitingState(), expiresAt: PAST }, { png: true });
    expect((await requestFor(stale, {})).status).toBe(202);
    expect((await requestFileIn(stale)).by).toBe("unknown");

    // So is asking after a finished handoff.
    for (const status of ["ok", "expired", "error"]) {
      const done = await handoff({ ...waitingState(), status });
      expect((await requestFor(done, {})).status).toBe(202);
    }
  });

  it("reports a write it could not make, rather than pretending the bot was asked", async () => {
    // A path that cannot become a directory: mkdir fails, so nothing is written.
    const blocked = join(await handoff(waitingState()), KBIZ_QR_STATE_FILE, "nested");
    const res = await requestFor(blocked, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "request-write-failed" });
  });

  it("answers the POST behind a router, passing the Access header through", async () => {
    const dir = await handoff();
    const app = new Elysia().post(KBIZ_QR_ROUTES.request, ({ headers }) => kbizLoginRequestResponse({ dir, headers }));
    const res = await app.handle(
      new Request(`http://localhost${KBIZ_QR_ROUTES.request}`, {
        method: "POST",
        headers: { [ACCESS_EMAIL_HEADER]: "sample-operator@example.com" },
        body: "ignored",
      })
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect((await requestFileIn(dir)).by).toBe("sample-operator@example.com");
  });
});

describe("kbiz login page states", () => {
  // The CSS names the views too, so read the card element, not the first match.
  const viewOf = (html: string) => html.match(/<section id="card"[^>]*data-view="([a-z]+)"/)?.[1];

  it("shows the QR first, whatever the session and the request say", async () => {
    const dir = await handoff(waitingState(), {
      png: true,
      session: sessionFile({ alive: true, pending: 3 }),
      request: { requestedAt: "2026-09-17T04:00:00.000Z", by: "sample-operator@example.com" },
    });
    const html = await htmlFor(dir);
    expect(viewOf(html)).toBe("qr");
    expect(html).toContain('data-status="waiting"');
    expect(html).toContain(`src="/kbiz/login-qr.png?t=${encodeURIComponent(UPDATED)}"`);
  });

  it("says it is preparing the QR while a request is outstanding, with no button", async () => {
    const requestedAt = "2026-09-17T04:00:00.000Z";
    const dir = await handoff(undefined, { request: { requestedAt, by: "sample-operator@example.com" } });
    const html = await htmlFor(dir);
    expect(viewOf(html)).toBe("preparing");
    expect(html).toContain("กำลังเตรียม QR…");
    expect(html).toContain(`ขอเมื่อ ${requestedAt}`);
    // A request that landed after a failed handoff still reads as preparing.
    const afterFailure = await handoff({ ...waitingState(), status: "expired" }, { request: { requestedAt } });
    expect(viewOf(await htmlFor(afterFailure))).toBe("preparing");
  });

  it("says the session is alive, with the pending count and nothing to press", async () => {
    const dir = await handoff(undefined, { session: sessionFile({ pending: 2 }) });
    const html = await htmlFor(dir);
    expect(viewOf(html)).toBe("alive");
    expect(html).toContain("เข้าสู่ระบบ K BIZ อยู่ ตั้งแต่ 2026-09-17T02:00:00.000Z");
    expect(html).toContain("มีงานรอโอน 2 รายการ");
  });

  it("offers the button when the session is dead, with the last result and the pending count", async () => {
    const dir = await handoff(
      { ...waitingState(), status: "expired", message: "ไม่มีการสแกนใน 6.5 นาที" },
      { session: sessionFile({ alive: false, endedAt: "2026-09-17T03:30:00.000Z", lastLifetimeMs: 5_400_000, pending: 1 }) }
    );
    const html = await htmlFor(dir);
    expect(viewOf(html)).toBe("button");
    expect(html).toContain('id="request-btn"');
    expect(html).toContain("เข้าสู่ระบบ K BIZ</button>");
    expect(html).toContain("ไม่มีการสแกนใน 6.5 นาที");
    expect(html).toContain("มีงานรอโอน 1 รายการ");
    expect(html).toContain("หมดอายุแล้ว");
    // The button is a POST to the contract's path, from the boot blob.
    expect(html).toContain('"request":"/kbiz/login-qr/request"');
  });

  it("renders idle as the button state with no data yet", async () => {
    const html = await htmlFor(await handoff());
    expect(viewOf(html)).toBe("button");
    expect(html).toContain('data-status="idle"');
    expect(html).toContain("ยังไม่มีข้อมูล");
    expect(html).toContain("เข้าสู่ระบบ K BIZ</button>");
  });

  it("carries the session and the request in the one poll the page makes", async () => {
    const session = sessionFile({ pending: 2 });
    const request = { requestedAt: "2026-09-17T04:00:00.000Z", by: "sample-operator@example.com" };
    const dir = await handoff(undefined, { session, request });
    expect(await stateBodyFor(dir)).toEqual({ status: "idle", session, request });

    // Absent files add no keys at all — `status` alone is still the whole body.
    expect(await stateBodyFor(await handoff())).toEqual({ status: "idle" });
  });

  it("forwards only the contract's session and request fields", async () => {
    const dir = await handoff(undefined, {
      session: { ...sessionFile(), accountNumber: "1234567890", note: "keepalive ok" },
      request: { requestedAt: "2026-09-17T04:00:00.000Z", by: "sample-operator@example.com", token: "SAMPLE SECRET" },
    });
    const body = await stateBodyFor(dir);
    expect(body).toEqual({
      status: "idle",
      session: sessionFile(),
      request: { requestedAt: "2026-09-17T04:00:00.000Z", by: "sample-operator@example.com" },
    });
    const serialized = JSON.stringify(body);
    for (const dropped of ["accountNumber", "1234567890", "SAMPLE SECRET", "token"]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it("never reads a broken session as logged in, and never loses a broken request", async () => {
    for (const broken of ["{", "null", "[]", '{"alive":"yes"}', '{"pending":2}']) {
      const dir = await handoff(undefined, { session: broken });
      const body = await stateBodyFor(dir);
      expect(body.session).toBeUndefined();
      expect(viewOf(await htmlFor(dir))).toBe("button");
    }
    // The bot claims `login.request` by NAME, so a file it cannot parse is
    // still a login being prepared — never a second button press on top of it.
    for (const broken of ["{", "not json", "[]"]) {
      const dir = await handoff(undefined, { request: broken });
      expect(await stateBodyFor(dir)).toEqual({ status: "idle", request: { requestedAt: null, by: "unknown" } });
      expect(viewOf(await htmlFor(dir))).toBe("preparing");
      expect((await requestFor(dir, {})).status).toBe(202);
      expect(await (await requestFor(dir, {})).json()).toEqual({ accepted: true, already: true });
    }
  });

  it("escapes everything that came off disk", async () => {
    const dir = await handoff(
      { ...waitingState(), status: "error", reason: '</script><img src=x onerror=alert(1)>' },
      { request: { requestedAt: "2026-09-17T04:00:00.000Z", by: '"><script>alert(2)</script>' } }
    );
    const html = await htmlFor(dir);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;/script&gt;&lt;img src=x");
    expect(html).toContain("\\u003c/script>");
  });
});
