import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { afterEach, before, it } from "node:test";

process.env.KB_ZB_REMOTE = "http://127.0.0.1:9/";
process.env.KB_INTERNAL_TOKEN = "t0k";
let readBoard: typeof import("../lib/push-alerts").readBoard;
before(async () => {
  ({ readBoard } = await import("../lib/push-alerts"));
});

const realFetch = globalThis.fetch;
let calls: { url: string; token: string | null }[] = [];
function stub(res: () => Response): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), token: new Headers(init?.headers).get("x-kb-internal") });
    return res();
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

it("reads a zbiorkom board from KB_ZB_REMOTE with the internal token", async () => {
  const rows = [{ line: "7", plan_ts: 100 }];
  stub(() => Response.json({ rows, server_ts: 1762560000 }));
  assert.deepEqual(await readBoard("gzm:12 3"), { rows, nowTs: 1762560000 });
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:9/api/stop/gzm%3A12%203/departures", token: "t0k" }]);
});

it("anything but a 200 board is null", async () => {
  stub(() => Response.json({ error: "Data is loading" }, { status: 503 }));
  assert.equal(await readBoard("gzm:1"), null);
  stub(() => Response.json({ rows: "x", server_ts: 1 }));
  assert.equal(await readBoard("gzm:1"), null);
  stub(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(await readBoard("gzm:1"), null);
});
