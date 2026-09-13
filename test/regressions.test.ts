import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RequestConfig } from "@localazy/api-client";
import type { McpServer } from "@modelcontextprotocol/server";
import { CHARACTER_LIMIT } from "../src/constants.js";
import { apiCache, cacheKeys, invalidateCache } from "../src/lib/cache.js";
import { getClient } from "../src/lib/client.js";
import { uploadJson } from "../src/lib/import.js";
import { rateLimiter } from "../src/lib/rate-limiter.js";
import { jsonResponseArray, type ToolResult } from "../src/lib/response.js";
import { listFlatTranslations } from "../src/lib/translations.js";
import { register as registerFind } from "../src/tools/find.js";
import { normalizeTranslationsForImport, translationsSchema, register as registerUpload } from "../src/tools/import.js";
import { register as registerKeys } from "../src/tools/keys.js";
import { detectTranslationIssues } from "../src/tools/quality.js";

const previousToken = process.env.LOCALAZY_API_TOKEN;
process.env.LOCALAZY_API_TOKEN = "unused-test-token";
const api = getClient();
if (previousToken === undefined) delete process.env.LOCALAZY_API_TOKEN;
else process.env.LOCALAZY_API_TOKEN = previousToken;

function setupApi(t: TestContext): void {
  invalidateCache();
  t.after(() => invalidateCache());
  apiCache.set(cacheKeys.projects, [{ id: "p", languages: [{ code: "en" }] }], 60_000);
  // Exercise the real SDK over a mocked HTTP adapter, without network or waits.
  t.mock.method(api.client, "get", async () => { throw new Error("Unexpected GET"); });
  t.mock.method(api.client, "post", async () => { throw new Error("Unexpected POST"); });
  t.mock.method(rateLimiter, "acquire", async () => {});
  t.mock.method(rateLimiter, "relax", () => null);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => timer(fn, 0));
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
function handler(register: (server: McpServer) => void): Handler {
  let callback: Handler | undefined;
  register({ registerTool(_name: string, _config: unknown, fn: Handler) { callback = fn; } } as unknown as McpServer);
  assert.ok(callback);
  return callback;
}

test("a 429 during file lookup never resends an accepted upload", async (t) => {
  setupApi(t);
  const post = t.mock.method(api.client, "post", async () => ({ result: "accepted" }));
  let lookups = 0;
  t.mock.method(api.client, "get", async () => {
    if (++lookups === 1) throw new Error("Request failed with status code 429: Too Many Requests");
    assert.equal(apiCache.get(cacheKeys.projects), undefined, "POST completion invalidates old reads");
    apiCache.set("after-post", "fresh", 60_000);
    return [{ id: "f", name: "f.json" }];
  });
  const result = await handler(registerUpload)({
    translations: { en: { title: "Hello" } }, file_name: "f.json",
    force_current: false, force_source: false, import_as_new: false,
  });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0]!.text).importBatch, "accepted");
  assert.equal(post.mock.callCount(), 1, "the accepted POST must not be repeated");
  assert.equal(apiCache.get("after-post"), "fresh", "lookup completion must not invalidate again");
});

test("dotted import keys cannot mutate Object.prototype", (t) => {
  t.after(() => Reflect.deleteProperty(Object.prototype, "reviewMarker"));
  const input = translationsSchema.parse({ en: { "__proto__.reviewMarker": "value" } });
  const result = normalizeTranslationsForImport(input);
  assert.equal(Object.hasOwn(Object.prototype, "reviewMarker"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse('{"en":{"__proto__":{"reviewMarker":"value"}}}'));
});

test("pagination preserves every matching key when pages exceed the budget", async (t) => {
  setupApi(t);
  const keys = Array.from({ length: 200 }, (_, i) => ({ key: [i % 2 ? "keep" : "other", String(i)], value: "x".repeat(1000) }));
  t.mock.method(api.client, "get", async (_url: string, config?: RequestConfig) => {
    const start = Number(config?.params?.next || 0);
    const end = Math.min(start + Number(config?.params?.limit), keys.length);
    return { keys: keys.slice(start, end), ...(end < keys.length ? { next: String(end) } : {}) };
  });
  const list = handler(registerKeys);
  for (const prefix of [undefined, "keep"]) {
    const seen: string[] = [];
    let next: string | undefined;
    do {
      const result = await list({ file_id: "f", lang: "en", limit: 100, extra_info: false, prefix, next });
      assert.equal(result.isError, undefined);
      assert.ok(result.content[0]!.text.length <= CHARACTER_LIMIT);
      const body = JSON.parse(result.content[0]!.text);
      seen.push(...body.keys.map((key: { key: string }) => key.key));
      if (body.next) assert.ok(Number(body.next) > Number(next || 0));
      next = body.next;
    } while (next);
    const expected = keys.filter((key) => !prefix || key.key[0] === prefix).map((key) => key.key.join("."));
    assert.equal(seen.length, expected.length, "pagination dropped keys");
    assert.deepEqual(seen, expected);
  }
});

test("a single oversized key fails explicitly without requesting a zero-sized page", async (t) => {
  setupApi(t);
  const limits: number[] = [];
  t.mock.method(api.client, "get", async (_url: string, config?: RequestConfig) => {
    limits.push(Number(config?.params?.limit));
    return { keys: [{ key: ["huge"], value: "x".repeat(CHARACTER_LIMIT) }] };
  });
  const result = await handler(registerKeys)({ file_id: "f", lang: "en", limit: 100, extra_info: false });
  assert.ok(limits.every((limit) => limit >= 1), "requested a zero-sized page");
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /LOCALAZY_CHARACTER_LIMIT/);
});

test("scans throttle each page and retry only the failed cursor", async (t) => {
  setupApi(t);
  const acquire = t.mock.method(rateLimiter, "acquire", async () => {});
  const cursors: string[] = [];
  let refused = false;
  t.mock.method(api.client, "get", async (_url: string, config?: RequestConfig) => {
    const cursor = String(config?.params?.next || "");
    cursors.push(cursor);
    if (cursor === "second" && !refused) {
      refused = true;
      throw new Error("Request failed with status code 429: Too Many Requests");
    }
    return { keys: [{ key: [cursor || "first"], value: "value" }], ...(cursor ? {} : { next: "second" }) };
  });
  const result = await listFlatTranslations("p", "f", "en");
  assert.deepEqual(result.map((entry) => entry.key), ["first", "second"]);
  assert.deepEqual(cursors, ["", "second", "second"]);
  assert.equal(acquire.mock.callCount(), 3);
  await listFlatTranslations("p", "f", "en");
  assert.equal(acquire.mock.callCount(), 3, "repeat scans use the cache");
  for (const cursor of [undefined, "second"]) {
    assert.equal(apiCache.get(cacheKeys.keysPage("p", "f", "en", 1000, false, cursor)), undefined,
      "scans must not retain raw pages alongside flat values");
  }
});

test("quote checks accept correctly spaced full sentences in each project language", () => {
  const cases = [
    ["en", "Click “Save” to continue"],
    ["de", "Klicken Sie auf „Speichern“ und weiter"],
    ["de", "Klicken Sie auf “Speichern” und weiter"],
    ["de", "„Hallo“ and “Hello”"],
    ["et_EE", "Vajuta „Salvesta“ ja jätka"],
    ["it", "Seleziona «Salva» per continuare"],
    ["fi", "Valitse ”Tallenna” ja jatka"],
    ["sv", "Välj ”Spara” och fortsätt"],
    ["fr", "Cliquez sur «\u202FEnregistrer\u202F» pour continuer"],
  ];
  for (const [lang, sentence] of cases) {
    assert.deepEqual(detectTranslationIssues(sentence!, undefined, lang!), [], lang);
  }
});

test("search distinguishes exactly 500 matches from a truncated file", async (t) => {
  setupApi(t);
  apiCache.set(cacheKeys.files("p"), [{ id: "f", name: "f.json" }], 60_000);
  const find = handler(registerFind);
  for (const count of [500, 600]) {
    apiCache.set(cacheKeys.flat("p", "f", "en"), Array.from({ length: count }, (_, i) => ({ key: String(i), text: "x" })), 60_000);
    const result = await find({ lang: "en", query: "x", file_ids: ["f"] });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(body.matches.length, 500);
    assert.equal(body.limited, count > 500, `${count} matching keys`);
  }
});

test("oversized metadata returns a bounded, valid JSON error", () => {
  const result = jsonResponseArray([{ key: "a" }], "keys", { files: { f: "x".repeat(CHARACTER_LIMIT) } });
  const body = JSON.parse(result.content[0]!.text);
  assert.ok(result.content[0]!.text.length <= CHARACTER_LIMIT);
  assert.equal(result.isError, true);
  assert.match(body.error, /metadata exceeds/);
});

test("upload helper invalidates after the POST retry settles, including uncertain failures", async (t) => {
  setupApi(t);
  let attempts = 0;
  const post = t.mock.method(api.client, "post", async () => {
    assert.ok(apiCache.get(cacheKeys.projects), "a refused attempt must not clear the cache");
    if (++attempts === 1) throw new Error("Request failed with status code 429: Too Many Requests");
    throw new Error("socket hang up");
  });
  await assert.rejects(uploadJson({ project: "p", json: { en: { title: "Hello" } } }), /socket hang up/);
  assert.equal(post.mock.callCount(), 2);
  assert.equal(apiCache.get(cacheKeys.projects), undefined, "uncertain POST outcomes invalidate old reads");
});
