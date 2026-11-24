import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { withVantio, reportAnomaly } from "../src/index.ts";

// VAN-396: the identity header can hold VANTIO_API_KEY, so reportAnomaly
// follows the `vantio export` rule and never sends it in plaintext to another
// machine. fetch is replaced so no request leaves the test.
describe("reportAnomaly() transport rule", () => {
  let fetched: string[];
  let warnCalls: unknown[][];
  let originalFetch: typeof globalThis.fetch;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    fetched = [];
    warnCalls = [];
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  async function send(ingestUrl: string): Promise<void> {
    await withVantio(async () => {
      await reportAnomaly({ target_host: "api.openai.com" }, { ingestUrl, identity: "vk_test_identity" });
    });
  }

  for (const url of ["http://192.0.2.10", "http://ingest.example.com:8080", "HTTP://Example.COM"]) {
    test(`refuses plain http to a remote host: ${url}`, async () => {
      await send(url);
      assert.deepEqual(fetched, []);
      assert.ok(warnCalls.some((c) => String(c[0]).includes("refuses plaintext to a remote host")), JSON.stringify(warnCalls));
    });
  }

  test("refuses credentials in the URL and schemes other than http and https", async () => {
    await send("https://user:pass@ingest.example.com");
    await send("file:///etc/passwd");
    await send("not a url");
    assert.deepEqual(fetched, []);
    const text = warnCalls.map((c) => String(c[0])).join("\n");
    assert.match(text, /must not contain credentials/);
    assert.match(text, /must be http or https/);
    assert.match(text, /is not valid/);
  });

  test("refuses an env-derived plain http remote URL too", async () => {
    const saved = { url: process.env.VANTIO_INGEST_URL, cloud: process.env.VANTIO_CLOUD_INGEST };
    process.env.VANTIO_INGEST_URL = "http://192.0.2.10";
    process.env.VANTIO_CLOUD_INGEST = "1";
    try {
      await withVantio(async () => { await reportAnomaly({ target_host: "x" }); });
      assert.deepEqual(fetched, []);
    } finally {
      if (saved.url === undefined) delete process.env.VANTIO_INGEST_URL; else process.env.VANTIO_INGEST_URL = saved.url;
      if (saved.cloud === undefined) delete process.env.VANTIO_CLOUD_INGEST; else process.env.VANTIO_CLOUD_INGEST = saved.cloud;
    }
  });

  test("sends over https to a remote host and over plain http to this machine", async () => {
    await send("https://ingest.example.com");
    await send("http://localhost:9");
    await send("http://127.0.0.1:9");
    await send("http://[::1]:9");
    assert.deepEqual(fetched, [
      "https://ingest.example.com/api/v1/ingest",
      "http://localhost:9/api/v1/ingest",
      "http://127.0.0.1:9/api/v1/ingest",
      "http://[::1]:9/api/v1/ingest",
    ]);
  });
});
