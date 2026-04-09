import assert from "node:assert/strict";
import test from "node:test";
import { TTLCache, cached, apiCache, invalidateProject } from "../src/lib/cache.js";
import { RateLimiter } from "../src/lib/rate-limiter.js";
import { handleError } from "../src/lib/errors.js";
import { jsonResponseArray } from "../src/lib/response.js";
import { flattenTranslations } from "../src/lib/translations.js";
import { findMatchedFields } from "../src/tools/find.js";
import { normalizeTranslationsForImport, translationsSchema } from "../src/tools/import.js";
import { formatListKeysPageOutput } from "../src/tools/keys.js";
import { detectTranslationIssues } from "../src/tools/quality.js";
import { localazyLocaleSchema, localazyLocalesSchema } from "../src/types.js";

test("translationsSchema accepts nested objects, plural maps, and string arrays", () => {
  const result = translationsSchema.safeParse({
    en: {
      common: {
        greeting: "Hello",
        items: ["One", "Two"],
        count: {
          one: "1 item",
          other: "%d items",
        },
      },
    },
    et: {
      common: {
        greeting: "Tere",
      },
    },
  });

  assert.equal(result.success, true);
});

test("translationsSchema rejects empty or malformed translation payloads", () => {
  const cases = [
    {},
    { en: "Hello" },
    { en: { greeting: 123 } },
    { en: { enabled: true } },
    { en: { greeting: null } },
    { en: { items: ["One", 2] } },
    { en: { common: { greeting: "Hello", count: { one: 1 } } } },
  ];

  for (const payload of cases) {
    const result = translationsSchema.safeParse(payload);
    assert.equal(result.success, false);
  }
});

test("normalizeTranslationsForImport expands flat dot-notation keys into nested objects", () => {
  const normalized = normalizeTranslationsForImport({
    en: {
      "messages.welcome": "Welcome",
      "common.count.one": "1 item",
      "common.count.other": "%d items",
    },
  });

  assert.deepEqual(normalized, {
    en: {
      messages: {
        welcome: "Welcome",
      },
      common: {
        count: {
          one: "1 item",
          other: "%d items",
        },
      },
    },
  });
});

test("normalizeTranslationsForImport rejects leaf and parent key conflicts", () => {
  assert.throws(
    () => normalizeTranslationsForImport({
      en: {
        messages: "Welcome",
        "messages.welcome": "Reviewed",
      },
    }),
    /Conflicting translation structure/
  );
});

test("locale schemas accept valid locale codes and reject invalid ones", () => {
  assert.equal(localazyLocaleSchema.safeParse("fr").success, true);
  assert.equal(localazyLocaleSchema.safeParse("french").success, false);
  assert.equal(localazyLocalesSchema.safeParse(["en", "de", "fr"]).success, true);
  assert.equal(localazyLocalesSchema.safeParse(["en", "french"]).success, false);
});

test("formatListKeysPageOutput includes extra_info metadata", () => {
  const output = formatListKeysPageOutput(
    {
      next: "cursor-123",
      keys: [
        {
          id: "key-1",
          key: ["common", "greeting"],
          value: "Hello",
          comment: "",
          deprecated: -1,
          hidden: false,
          limit: 40,
        },
      ],
    },
    true
  );

  assert.deepEqual(output, {
    count: 1,
    next: "cursor-123",
    keys: [
      {
        id: "key-1",
        key: "common.greeting",
        value: "Hello",
        limit: 40,
      },
    ],
  });
});

test("formatListKeysPageOutput omits key IDs when extra_info is false", () => {
  const output = formatListKeysPageOutput(
    {
      next: undefined,
      keys: [
        {
          id: "key-1",
          key: ["common", "greeting"],
          value: "Hello",
        },
      ],
    },
    false
  );

  assert.deepEqual(output, {
    count: 1,
    next: undefined,
    keys: [
      {
        key: "common.greeting",
        value: "Hello",
      },
    ],
  });
});

test("flattenTranslations expands plural maps and arrays into addressable keys", () => {
  const flattened = flattenTranslations([
    {
      id: "key-1",
      key: ["common", "count"],
      value: {
        one: "1 item",
        other: ["%d items", "many items"],
      },
    },
  ]);

  assert.deepEqual(flattened, [
    { key: "common.count.one", text: "1 item" },
    { key: "common.count.other[0]", text: "%d items" },
    { key: "common.count.other[1]", text: "many items" },
  ]);
});

test("detectTranslationIssues finds whitespace and punctuation problems", () => {
  const findings = detectTranslationIssues(" Tere  ", "Hello!");

  assert.deepEqual(findings, [
    {
      type: "leading_or_trailing_whitespace",
      message: "Target has leading or trailing whitespace.",
    },
    {
      type: "double_spaces",
      message: "Target contains consecutive spaces.",
    },
    {
      type: "terminal_punctuation_mismatch",
      message: "Source ends with '!' but target ends with '(none)'.",
    },
  ]);
});

test("detectTranslationIssues finds a space before punctuation", () => {
  const findings = detectTranslationIssues("Tere !", "Hello!", "en");

  assert.deepEqual(findings, [
    {
      type: "space_before_punctuation",
      message: "Target has a space immediately before punctuation.",
    },
  ]);
});

test("detectTranslationIssues allows French spacing before terminal punctuation", () => {
  assert.deepEqual(detectTranslationIssues("Bonjour !", "Hello!", "fr"), []);
  assert.deepEqual(detectTranslationIssues("Bonjour\u202F!", "Hello!", "fr"), []);
});

test("detectTranslationIssues still flags spaces before comma and period in French", () => {
  const commaFindings = detectTranslationIssues("Bonjour ,", "Hello,", "fr");
  const periodFindings = detectTranslationIssues("Bonjour .", "Hello.", "fr");

  assert.deepEqual(commaFindings, [
    {
      type: "space_before_punctuation",
      message: "Target has a space immediately before punctuation.",
    },
  ]);

  assert.deepEqual(periodFindings, [
    {
      type: "space_before_punctuation",
      message: "Target has a space immediately before punctuation.",
    },
  ]);
});

test("detectTranslationIssues treats three dots and ellipsis as the same punctuation", () => {
  const findings = detectTranslationIssues("Tere…", "Hello...");

  assert.deepEqual(findings, []);
});

test("findMatchedFields reports whether the query matched key and target text", () => {
  assert.deepEqual(
    findMatchedFields("invoice", "billing.invoice.title", "Arve"),
    ["key"]
  );

  assert.deepEqual(
    findMatchedFields("arve", "billing.invoice.title", "Arve"),
    ["target_value"]
  );
});

test("handleError maps known HTTP status codes to friendly messages", () => {
  const cases = [
    {
      error: new Error("Request failed with status code 401: Unauthorized"),
      expected:
        "Error: Authentication failed. Check your LOCALAZY_API_TOKEN is valid.",
    },
    {
      error: new Error("Request failed with status code 403: Forbidden"),
      expected:
        "Error: Permission denied. Your token may not have access to this resource.",
    },
    {
      error: new Error("Request failed with status code 404: Not Found"),
      expected:
        "Error: Resource not found. Check the project/file ID is correct. Use localazy_list_projects and localazy_list_files to get valid IDs.",
    },
    {
      error: new Error("Request failed with status code 429: Too Many Requests"),
      expected:
        "Error: Rate limit exceeded. Localazy allows 100 requests/min. Wait before retrying.",
    },
  ];

  for (const { error, expected } of cases) {
    assert.equal(handleError(error), expected);
  }
});

test("handleError falls back cleanly for unknown statuses and non-status errors", () => {
  assert.equal(
    handleError(new Error("Request failed with status code 500: Internal Server Error")),
    "Error: API request failed (HTTP 500): Request failed with status code 500: Internal Server Error"
  );

  assert.equal(handleError(new Error("Socket hang up")), "Error: Socket hang up");
  assert.equal(handleError("boom"), "Error: Unexpected error: boom");
});

test("TTLCache returns cached values and expires them after TTL", async () => {
  const cache = new TTLCache<string>();

  cache.set("a", "hello", 100);
  assert.equal(cache.get("a"), "hello");

  // Expired entries are pruned
  cache.set("b", "world", 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cache.get("b"), undefined);

  // Missing keys return undefined
  assert.equal(cache.get("missing"), undefined);
});

test("invalidateProject clears only the targeted project's entries", () => {
  apiCache.set("files:projA", "fA", 60_000);
  apiCache.set("languages:projA", "lA", 60_000);
  apiCache.set("keys:projA:file1:en:100:false:first", "k1", 60_000);
  apiCache.set("keys:projA:file2:en:1000:false:first", "k2", 60_000);
  apiCache.set("files:projB", "fB", 60_000);
  apiCache.set("keys:projB:file3:en:100:false:first", "k3", 60_000);

  try {
    invalidateProject("projA");

    assert.equal(apiCache.get("files:projA"), undefined);
    assert.equal(apiCache.get("languages:projA"), undefined);
    assert.equal(apiCache.get("keys:projA:file1:en:100:false:first"), undefined);
    assert.equal(apiCache.get("keys:projA:file2:en:1000:false:first"), undefined);
    assert.equal(apiCache.get("files:projB"), "fB");
    assert.equal(apiCache.get("keys:projB:file3:en:100:false:first"), "k3");
  } finally {
    invalidateProject("projA");
    invalidateProject("projB");
  }
});

test("cached() deduplicates concurrent requests for the same key", async () => {
  let callCount = 0;
  const fn = () => new Promise<string>((resolve) => {
    callCount++;
    setTimeout(() => resolve("result"), 20);
  });

  const results = await Promise.all([
    cached("dedup-test", fn),
    cached("dedup-test", fn),
    cached("dedup-test", fn),
    cached("dedup-test", fn),
    cached("dedup-test", fn),
  ]);

  assert.equal(callCount, 1, "fn should be called exactly once");
  for (const r of results) {
    assert.equal(r, "result");
  }
});

test("cached() does not poison cache when fn rejects", async () => {
  let attempt = 0;
  const failing = () => { attempt++; return Promise.reject(new Error("boom")); };
  const succeeding = () => { attempt++; return Promise.resolve("ok"); };

  await assert.rejects(() => cached("poison-test", failing), /boom/);
  const result = await cached("poison-test", succeeding);
  assert.equal(result, "ok");
  assert.equal(attempt, 2, "second fn should have been called after first rejection");
});

test("RateLimiter acquire() is immediate when tokens are available", async () => {
  const limiter = new RateLimiter(100);
  const start = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  const elapsed = Date.now() - start;
  // Should be near-instant (well under 50ms)
  assert.equal(elapsed < 50, true);
});

test("jsonResponseArray truncates to valid JSON with _meta", () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ key: `k.${i}`, value: "x".repeat(50) }));
  const parsed = JSON.parse(jsonResponseArray(items, "keys", { query: "test" }).content[0]!.text);

  assert.equal(parsed._meta.truncated, true);
  assert.equal(parsed._meta.total, 5000);
  assert.equal(parsed._meta.included, parsed.keys.length);
  assert.equal(parsed.query, "test");
});

test("jsonResponseArray exposes _arrayMeta with truncation info", () => {
  const small = Array.from({ length: 5 }, (_, i) => ({ key: `k.${i}`, value: "hi" }));
  const result = jsonResponseArray(small, "keys");
  assert.equal(result._arrayMeta.truncated, false);
  assert.equal(result._arrayMeta.includedCount, 5);
  assert.equal(result._arrayMeta.totalCount, 5);

  const large = Array.from({ length: 5000 }, (_, i) => ({ key: `k.${i}`, value: "x".repeat(50) }));
  const truncated = jsonResponseArray(large, "keys");
  assert.equal(truncated._arrayMeta.truncated, true);
  assert.equal(truncated._arrayMeta.totalCount, 5000);
  assert.equal(truncated._arrayMeta.includedCount < 5000, true);
  assert.equal(truncated._arrayMeta.includedCount > 0, true);
});

test("RateLimiter queues when tokens are exhausted", async () => {
  // 120 tokens/min = 1 token every 500ms. Drain all, then next acquire must wait.
  const limiter = new RateLimiter(120);
  for (let i = 0; i < 120; i++) await limiter.acquire();

  const start = Date.now();
  await limiter.acquire();
  const elapsed = Date.now() - start;
  // Should wait ~500ms for one token refill
  assert.equal(elapsed >= 400, true);
  assert.equal(elapsed < 2000, true);
});
