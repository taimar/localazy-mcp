import assert from "node:assert/strict";
import test from "node:test";
import { TTLCache, cached, apiCache, cacheKeys, invalidateCache } from "../src/lib/cache.js";
import { mapWithConcurrency } from "../src/lib/concurrency.js";
import { envInt } from "../src/constants.js";
import { RateLimiter } from "../src/lib/rate-limiter.js";
import { handleError } from "../src/lib/errors.js";
import { isRetryable, withRetry, withWriteRetry } from "../src/lib/retry.js";
import { jsonResponseArray } from "../src/lib/response.js";
import { flattenTranslations } from "../src/lib/translations.js";
import { matchFields } from "../src/tools/find.js";
import { normalizeTranslationsForImport, translationsSchema } from "../src/tools/import.js";
import { formatListKeysPageOutput } from "../src/tools/keys.js";
import {
  ISSUE_TYPES,
  detectTranslationIssues,
  requiresSourceValues,
  resolveAuditTypes,
  serializeAuditIssues,
} from "../src/tools/quality.js";
import { localazyLocaleSchema } from "../src/types.js";

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

test("locale schema accepts valid locale codes and rejects invalid ones", () => {
  assert.equal(localazyLocaleSchema.safeParse("fr").success, true);
  assert.equal(localazyLocaleSchema.safeParse("et").success, true);
  assert.equal(localazyLocaleSchema.safeParse("french").success, false);
  assert.equal(localazyLocaleSchema.safeParse("").success, false);
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

test("detectTranslationIssues flags missing and extra placeholders", () => {
  const findings = detectTranslationIssues(
    "Delivery {{shipment_number}}/{{shipment_total}} of order #{{order_id}} has shipped.",
    "Delivery {{shipment_number}}/{{shipment_count}} of order #{{order_id}} has shipped.",
    "en"
  );

  assert.deepEqual(findings, [
    {
      type: "missing_placeholders",
      message: "Target is missing placeholders: {{shipment_count}}.",
    },
    {
      type: "extra_placeholders",
      message: "Target has extra placeholders: {{shipment_total}}.",
    },
  ]);
});

test("detectTranslationIssues flags missing tags", () => {
  const findings = detectTranslationIssues(
    "Click Save to continue.",
    "Click <strong>Save</strong> to continue.",
    "en"
  );

  assert.deepEqual(findings, [
    {
      type: "missing_tags",
      message: "Target is missing tags: <strong>.",
    },
  ]);
});

test("detectTranslationIssues detects punctuation before closing tags", () => {
  const findings = detectTranslationIssues(
    "<2><0>Expected delivery date is {{expected_delivery}}!</0></2>",
    "<2><0>Expected delivery date is {{expected_delivery}}.</0></2>",
    "en"
  );

  assert.deepEqual(findings, [
    {
      type: "terminal_punctuation_mismatch",
      message: "Source ends with '.' but target ends with '!'.",
    },
  ]);
});

test("detectTranslationIssues detects punctuation before trailing self-closing tags", () => {
  assert.deepEqual(
    detectTranslationIssues("<p>Hello!</p><br/>", "<p>Hello.</p><br/>", "en"),
    [
      {
        type: "terminal_punctuation_mismatch",
        message: "Source ends with '.' but target ends with '!'.",
      },
    ]
  );

  assert.deepEqual(
    detectTranslationIssues("<p>Hello!</p><br />", "<p>Hello.</p><br />", "en"),
    [
      {
        type: "terminal_punctuation_mismatch",
        message: "Source ends with '.' but target ends with '!'.",
      },
    ]
  );
});

test("detectTranslationIssues flags invalid tag structure", () => {
  const findings = detectTranslationIssues(
    "<p><b>Job:</p></b>",
    "<p><b>Job:</b></p>",
    "en"
  );

  assert.deepEqual(findings, [
    {
      type: "invalid_tag_structure",
      message: "Target has invalid tag structure: expected </b> but found </p>.",
    },
  ]);
});

test("detectTranslationIssues flags ellipsis style", () => {
  const findings = detectTranslationIssues("Tere...", "Hello...", "en");

  assert.deepEqual(findings, [
    {
      type: "ellipsis_style",
      message: "Target uses '...' instead of the ellipsis character '…'.",
    },
  ]);
});

test("detectTranslationIssues flags straight apostrophes in contractions and possessives", () => {
  assert.deepEqual(detectTranslationIssues("don't", undefined, "en"), [
    {
      type: "apostrophe_style",
      message: "Use curly apostrophes (’) instead of straight apostrophes in contractions and possessives.",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("{{order_id}}'s status", undefined, "en"), [
    {
      type: "apostrophe_style",
      message: "Use curly apostrophes (’) instead of straight apostrophes in contractions and possessives.",
    },
  ]);
});

test("detectTranslationIssues does not flag quoted words as apostrophe style issues", () => {
  assert.deepEqual(detectTranslationIssues("('Hello')", undefined, "en"), []);
});

test("detectTranslationIssues flags unbalanced quotation marks", () => {
  const findings = detectTranslationIssues("\"Hello", undefined, "en");

  assert.deepEqual(findings, [
    {
      type: "quote_balance",
      message: "Target has unbalanced quotation marks.",
    },
  ]);
});

test("detectTranslationIssues flags inner spacing in curly quotes", () => {
  const findings = detectTranslationIssues("“ Hello ”", undefined, "en");

  assert.deepEqual(findings, [
    {
      type: "quote_inner_spacing",
      message: "Curly or directional quotes should not have spaces directly inside the quote marks.",
    },
  ]);
});

test("detectTranslationIssues accepts balanced German-style quotes", () => {
  const findings = detectTranslationIssues("„Hallo“", undefined, "de");

  assert.deepEqual(findings, []);
});

test("detectTranslationIssues flags inner spacing in German-style quotes", () => {
  const findings = detectTranslationIssues("„ Hallo “", undefined, "de");

  assert.deepEqual(findings, [
    {
      type: "quote_inner_spacing",
      message: "Curly or directional quotes should not have spaces directly inside the quote marks.",
    },
  ]);
});

test("detectTranslationIssues flags inner spacing in parentheses", () => {
  assert.deepEqual(detectTranslationIssues("( hello )", undefined, "en"), [
    {
      type: "parenthesis_inner_spacing",
      message: "Parentheses should not have spaces directly inside them.",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("(hello)", undefined, "en"), []);
});

test("detectTranslationIssues flags non-guillemet French quote style", () => {
  const findings = detectTranslationIssues("\"Bonjour\"", undefined, "fr");

  assert.deepEqual(findings, [
    {
      type: "french_quote_style",
      message: "French text should use guillemets (« ») instead of straight or curly double quotes.",
    },
  ]);
});

test("detectTranslationIssues flags ASCII spaces inside French guillemets", () => {
  const findings = detectTranslationIssues("« Bonjour »", undefined, "fr");

  assert.deepEqual(findings, [
    {
      type: "french_guillemet_spacing",
      message: "Spaces inside French guillemets should use a non-breaking or narrow non-breaking space.",
    },
  ]);
});

test("detectTranslationIssues flags unsupported Unicode spaces inside French guillemets", () => {
  assert.deepEqual(detectTranslationIssues("«\u2009Bonjour\u2009»", undefined, "fr"), [
    {
      type: "french_guillemet_spacing",
      message: "Spaces inside French guillemets should use a non-breaking or narrow non-breaking space.",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("«\u200ABonjour\u200A»", undefined, "fr"), [
    {
      type: "french_guillemet_spacing",
      message: "Spaces inside French guillemets should use a non-breaking or narrow non-breaking space.",
    },
  ]);
});

test("detectTranslationIssues accepts non-breaking spaces inside French guillemets", () => {
  assert.deepEqual(detectTranslationIssues("«\u00A0Bonjour\u00A0»", undefined, "fr"), []);
  assert.deepEqual(detectTranslationIssues("«\u202FBonjour\u202F»", undefined, "fr"), []);
});

test("detectTranslationIssues flags inner spacing in non-French guillemets", () => {
  const findings = detectTranslationIssues("« Hello »", undefined, "en");

  assert.deepEqual(findings, [
    {
      type: "quote_inner_spacing",
      message: "Non-French guillemets should not have spaces directly inside the quote marks.",
    },
  ]);
});

test("detectTranslationIssues flags dash style for ranges and spaced dashes", () => {
  const findings = detectTranslationIssues("Range 1-2 - done", undefined, "en");

  assert.deepEqual(findings, [
    {
      type: "dash_style",
      message: "Use an en dash for numeric ranges (for example '1–2').",
    },
    {
      type: "dash_style",
      message: "Use an en dash for spaced dashes (for example ' – ').",
    },
  ]);
});

test("detectTranslationIssues flags spaced en dashes in numeric ranges", () => {
  assert.deepEqual(detectTranslationIssues("Range 1 – 2", undefined, "en"), [
    {
      type: "dash_style",
      message: "Use an en dash for numeric ranges (for example '1–2').",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("Range 1–2", undefined, "en"), []);
});

test("detectTranslationIssues flags unspaced em dash sentence style in non-French locales", () => {
  const findings = detectTranslationIssues(
    "tsink—ideaalne keermega või keerulise kujuga detailidele",
    undefined,
    "et"
  );

  assert.deepEqual(findings, [
    {
      type: "dash_style",
      message: "Use a spaced en dash for sentence dashes (for example ' – ').",
    },
  ]);
});

test("detectTranslationIssues allows French em dash sentence style", () => {
  assert.deepEqual(detectTranslationIssues("Bonjour — monde", undefined, "fr"), []);
  assert.deepEqual(detectTranslationIssues("Bonjour\u2009—\u2009monde", undefined, "fr"), []);
  assert.deepEqual(detectTranslationIssues("Bonjour—monde", undefined, "fr"), []);
});

test("detectTranslationIssues flags asymmetric em dash spacing", () => {
  assert.deepEqual(detectTranslationIssues("Hello— world", undefined, "en"), [
    {
      type: "dash_style",
      message: "Em dashes should have either spaces on both sides or no spaces on either side.",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("Bonjour —monde", undefined, "fr"), [
    {
      type: "dash_style",
      message: "Em dashes should have either spaces on both sides or no spaces on either side.",
    },
  ]);
});

test("detectTranslationIssues flags asymmetric em dash spacing with Unicode spaces", () => {
  assert.deepEqual(detectTranslationIssues("Hello—\u2009world", undefined, "en"), [
    {
      type: "dash_style",
      message: "Em dashes should have either spaces on both sides or no spaces on either side.",
    },
  ]);

  assert.deepEqual(detectTranslationIssues("Bonjour\u200A—monde", undefined, "fr"), [
    {
      type: "dash_style",
      message: "Em dashes should have either spaces on both sides or no spaces on either side.",
    },
  ]);
});

test("matchFields reports which sides the query matched", () => {
  assert.deepEqual(matchFields("invoice", "billing.invoice.title", "Arve"), ["key"]);
  assert.deepEqual(matchFields("arve", "billing.invoice.title", "Arve"), ["target_value"]);
  assert.deepEqual(
    matchFields("invoice", "billing.invoice.title", "Invoice total"),
    ["key", "target_value"]
  );
  // Misses return null rather than an empty array — this runs once per value.
  assert.equal(matchFields("absent", "billing.invoice.title", "Arve"), null);
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
        "Error: Resource not found. Check the file ID is correct. Use localazy_list_files to get valid IDs.",
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

test("TTLCache sweeps expired entries as writes arrive, so a paging session stays flat", async () => {
  // What this guards: page cache keys vary by limit and cursor, so nothing ever
  // reads a page again to evict it lazily. Without the sweep, a long paging
  // session retains every page it ever fetched, at ~150 KB each.
  const cache = new TTLCache<string>(0); // sweep on every write
  for (let i = 0; i < 10; i++) cache.set(`page-${i}`, "x", 20);
  assert.equal(cache.size, 10);

  await new Promise((r) => setTimeout(r, 30));
  cache.set("fresh", "x", 60_000);

  assert.equal(cache.size, 1, "the ten expired pages should be evicted, not merely unreadable");
});

test("invalidateCache drops every cached entry", () => {
  apiCache.set(cacheKeys.projects, "p", 60_000);
  apiCache.set(cacheKeys.files("projA"), "fA", 60_000);
  apiCache.set(cacheKeys.flat("projA", "file1", "et"), "t1", 60_000);
  apiCache.set(cacheKeys.keysPage("projA", "file1", "en", 100, false), "k1", 60_000);

  invalidateCache();

  assert.equal(apiCache.get(cacheKeys.projects), undefined);
  assert.equal(apiCache.get(cacheKeys.files("projA")), undefined);
  assert.equal(apiCache.get(cacheKeys.flat("projA", "file1", "et")), undefined);
  assert.equal(apiCache.get(cacheKeys.keysPage("projA", "file1", "en", 100, false)), undefined);
});

test("cacheKeys distinguishes files, languages, and pagination cursors", () => {
  const keys = [
    cacheKeys.projects,
    cacheKeys.files("p"),
    cacheKeys.flat("p", "f1", "en"),
    cacheKeys.flat("p", "f1", "et"),
    cacheKeys.flat("p", "f2", "en"),
    cacheKeys.keysPage("p", "f1", "en", 100, false),
    cacheKeys.keysPage("p", "f1", "en", 100, true),
    cacheKeys.keysPage("p", "f1", "en", 100, false, "cursor"),
  ];

  assert.equal(new Set(keys).size, keys.length, "each key must be distinct");
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

test("RateLimiter acquire() is immediate while the windows have room", async () => {
  const limiter = new RateLimiter([{ capacity: 10, windowMs: 1000 }]);
  const start = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  const elapsed = Date.now() - start;
  // Generous bound: the point is that no throttling happened, not the exact cost.
  assert.equal(elapsed < 250, true, `expected no throttling, took ${elapsed}ms`);
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

test("mapWithConcurrency keeps input order and bounds parallelism", async () => {
  const items = [40, 5, 30, 10, 20, 1];
  let active = 0;
  let peakActive = 0;

  const results = await mapWithConcurrency(items, 2, async (item) => {
    active++;
    peakActive = Math.max(peakActive, active);
    await new Promise((r) => setTimeout(r, item));
    active--;
    return item * 2;
  });

  assert.deepEqual(results, [80, 10, 60, 20, 40, 2]);
  assert.equal(peakActive <= 2, true, "should never exceed the concurrency limit");
});

test("mapWithConcurrency stops claiming work once shouldStop returns true", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  let processed = 0;

  const results = await mapWithConcurrency(
    items,
    2,
    async (item) => {
      processed++;
      await new Promise((r) => setTimeout(r, 1));
      return item;
    },
    () => processed >= 4,
  );

  assert.equal(processed < items.length, true, "should not process every item");
  // Workers claim indexes in order and always await what they claimed, so the
  // result is a dense prefix — shorter than the input, never sparse.
  assert.equal(results.length, processed);
  for (let i = 0; i < results.length; i++) {
    assert.equal(i in results, true, `index ${i} must be assigned`);
  }
  assert.deepEqual(results, items.slice(0, processed));
});

test("envInt falls back when unset or unparseable and enforces a minimum", () => {
  delete process.env.LOCALAZY_TEST_INT;
  assert.equal(envInt("LOCALAZY_TEST_INT", 7), 7);

  process.env.LOCALAZY_TEST_INT = "not-a-number";
  assert.equal(envInt("LOCALAZY_TEST_INT", 7), 7);

  process.env.LOCALAZY_TEST_INT = "0";
  assert.equal(envInt("LOCALAZY_TEST_INT", 7), 1);

  process.env.LOCALAZY_TEST_INT = "25";
  assert.equal(envInt("LOCALAZY_TEST_INT", 7), 25);

  delete process.env.LOCALAZY_TEST_INT;
});

test("TTLCache getEntry distinguishes a cached undefined from a missing key", () => {
  const cache = new TTLCache<string | undefined>();
  cache.set("present", undefined, 60_000);

  assert.equal(cache.getEntry("present")?.value, undefined);
  assert.notEqual(cache.getEntry("present"), undefined, "entry should exist");
  assert.equal(cache.getEntry("absent"), undefined);
});

test("serializeAuditIssues hoists repeated messages into the rules legend", () => {
  const repeated = "Target contains consecutive spaces.";
  const { issues, rules } = serializeAuditIssues([
    { type: "double_spaces", message: repeated, fileId: "f1", key: "a", targetValue: "a  b" },
    { type: "double_spaces", message: repeated, fileId: "f1", key: "b", targetValue: "c  d" },
    {
      type: "missing_placeholders",
      message: "Target is missing placeholders: {{id}}.",
      fileId: "f2",
      key: "c",
      targetValue: "Tere",
      sourceValue: "Hello {{id}}",
    },
  ]);

  assert.equal(rules.double_spaces, repeated);
  // The repeated message is carried by the legend, not by each issue.
  assert.equal(issues[0]!.message, undefined);
  assert.equal(issues[1]!.message, undefined);
  assert.equal(issues[0]!.target_value, "a  b");
  assert.equal(issues[0]!.source_value, undefined);
  assert.equal(issues[2]!.source_value, "Hello {{id}}");

  // Every message stays recoverable.
  for (const issue of issues) {
    assert.equal(typeof (issue.message ?? rules[issue.type]), "string");
  }
});

test("serializeAuditIssues leaves parameterized messages inline rather than promoting one", () => {
  const spaced = "Use an en dash for spaced dashes (for example ' – ').";
  const range = "Use an en dash for numeric ranges (for example '1–2').";
  const { issues, rules } = serializeAuditIssues([
    { type: "dash_style", message: spaced, fileId: "f1", key: "a", targetValue: "a - b" },
    { type: "dash_style", message: spaced, fileId: "f1", key: "b", targetValue: "c - d" },
    { type: "dash_style", message: range, fileId: "f1", key: "c", targetValue: "1-2" },
  ]);

  // Promoting the majority message would misdescribe the third issue.
  assert.equal(rules.dash_style, undefined);
  assert.equal(issues[0]!.message, spaced);
  assert.equal(issues[1]!.message, spaced);
  assert.equal(issues[2]!.message, range);
});

test("detectTranslationIssues flags non-breaking space at the value edge", () => {
  assert.deepEqual(detectTranslationIssues("\u00A0Tere", undefined, "en"), [
    {
      type: "leading_or_trailing_whitespace",
      message: "Target has leading or trailing whitespace.",
    },
  ]);
});

test("detectTranslationIssues reads punctuation through trailing closers", () => {
  assert.deepEqual(detectTranslationIssues("(Tere)", "(Hello.)", "en"), [
    {
      type: "terminal_punctuation_mismatch",
      message: "Source ends with '.' but target ends with '(none)'.",
    },
  ]);
});

test("detectTranslationIssues leaves ordinary hyphens and stray angle brackets alone", () => {
  assert.deepEqual(detectTranslationIssues("e-mail", undefined, "en"), []);
  assert.deepEqual(detectTranslationIssues("a > b", undefined, "en"), []);
  assert.deepEqual(detectTranslationIssues("2 < 3", undefined, "en"), []);
});

test("RateLimiter makes a caller wait for the window to roll once it is full", async () => {
  const limiter = new RateLimiter([{ capacity: 5, windowMs: 400 }]);
  for (let i = 0; i < 5; i++) await limiter.acquire();

  const start = Date.now();
  await limiter.acquire();
  const elapsed = Date.now() - start;

  assert.equal(elapsed >= 350, true, `expected a wait, took ${elapsed}ms`);
  assert.equal(elapsed < 2000, true);
});

/** Acquire `count` slots at once, and report when each one was released. */
async function collectReleases(limiter: RateLimiter, count: number): Promise<number[]> {
  const start = Date.now();
  const releases: number[] = [];

  await Promise.all(
    Array.from({ length: count }, () =>
      limiter.acquire().then(() => releases.push(Date.now() - start))
    )
  );

  return releases;
}

/**
 * The most releases that any trailing window of `windowMs` holds.
 *
 * Every offset is measured, not only the first window, so the result holds
 * regardless of how loaded the machine is.
 */
function maxInAnyWindow(releases: number[], windowMs: number): number {
  let peak = 0;

  for (const release of releases) {
    const inWindow = releases.filter((t) => t >= release && t < release + windowMs).length;
    peak = Math.max(peak, inWindow);
  }

  return peak;
}

test("RateLimiter never exceeds the cap in any window, even under a burst", async () => {
  // A token bucket would let 2x the cap through the first window; that is what
  // trips Localazy's 10 req/s ceiling during a parallel project scan.
  const capacity = 10;
  const windowMs = 1000;
  const limiter = new RateLimiter([{ capacity, windowMs }]);

  const releases = await collectReleases(limiter, 25);

  assert.equal(releases.length, 25, "every caller must eventually be released");
  const peak = maxInAnyWindow(releases, windowMs);
  assert.equal(peak <= capacity, true, `${peak} releases inside one window`);
});

test("RateLimiter relax() halves the shortest window and stops at the floor", async () => {
  const limiter = new RateLimiter([
    { capacity: 30, windowMs: 1000 },
    { capacity: 90, windowMs: 60_000 },
  ]);

  assert.equal(limiter.relax(), 15);
  assert.equal(limiter.relax(), 7);
  assert.equal(limiter.relax(), 5, "floors at the minimum");
  assert.equal(limiter.relax(), null, "reports nothing left to give up");
});

test("RateLimiter relax() never raises a capacity configured below the floor", async () => {
  // LOCALAZY_RATE_LIMIT_PER_SECOND=3 is a deliberate choice by whoever set it, so
  // a 429 must not walk it up to the floor — which would answer pushback by going
  // faster, and make withRetry log an increase as a "reduction".
  const windowMs = 400;
  const limiter = new RateLimiter([{ capacity: 3, windowMs }]);

  assert.equal(limiter.relax(), null, "below the floor there is nothing to give up");

  const peak = maxInAnyWindow(await collectReleases(limiter, 4), windowMs);
  assert.equal(peak <= 3, true, `${peak} releases inside one window, the cap was 3`);
});

test("RateLimiter honours a relaxed capacity on subsequent acquires", async () => {
  const windowMs = 500;
  const limiter = new RateLimiter([{ capacity: 20, windowMs }]);
  assert.equal(limiter.relax(), 10);

  // With the cap now 10, the 11th cannot share a window with the first ten.
  const peak = maxInAnyWindow(await collectReleases(limiter, 11), windowMs);
  assert.equal(peak <= 10, true, `${peak} releases inside one window`);
});

test("RateLimiter enforces every window it is given", async () => {
  // Tight per-second cap under a looser long window: the strictest one wins.
  const limiter = new RateLimiter([
    { capacity: 2, windowMs: 300 },
    { capacity: 100, windowMs: 60_000 },
  ]);

  // The tighter window binds: at most 2 releases in any 300ms stretch.
  const peak = maxInAnyWindow(await collectReleases(limiter, 6), 300);
  assert.equal(peak <= 2, true, `${peak} releases inside the tight window`);
});

test("resolveAuditTypes narrows a scope instead of widening it", () => {
  // missing_tags is a syntax rule, so the style scope drops it.
  assert.deepEqual([...resolveAuditTypes("style", ["dash_style", "missing_tags"])], ["dash_style"]);
});

test("resolveAuditTypes keeps every requested type under scope 'all'", () => {
  assert.deepEqual(
    [...resolveAuditTypes("all", ["dash_style", "missing_tags"])].sort(),
    ["dash_style", "missing_tags"]
  );
});

test("resolveAuditTypes refuses a filter that excludes everything in scope", () => {
  // Serving this would scan every file and report zero issues, which reads as a
  // clean language rather than as a filter that matches nothing.
  assert.throws(() => resolveAuditTypes("syntax", ["dash_style", "ellipsis_style"]), (error) => {
    const { message } = error as Error;
    assert.match(message, /^no requested type belongs to scope 'syntax'/);
    assert.match(message, /dash_style, ellipsis_style/);
    assert.match(message, /Use scope 'all', or 'style'/);
    return true;
  });
});

test("resolveAuditTypes expands a missing or empty type list to the whole scope", () => {
  for (const types of [undefined, []]) {
    assert.deepEqual([...resolveAuditTypes("all", types)].sort(), [...ISSUE_TYPES].sort());
  }
});

test("resolveAuditTypes returns the set that decides what an audit reports", () => {
  // The resolved set is the only gate downstream, so scope and types have to be
  // answered here rather than re-derived per issue.
  assert.equal(resolveAuditTypes("style").has("dash_style"), true);
  assert.equal(resolveAuditTypes("syntax").has("dash_style"), false);
  assert.equal(resolveAuditTypes("all").has("dash_style"), true);
  assert.equal(resolveAuditTypes("all", ["dash_style"]).has("ellipsis_style"), false);
});

test("requiresSourceValues is true for exactly the rules that compare the source", () => {
  // Hardcoded rather than derived, so this asserts the intended set instead of
  // restating the implementation. A false negative here would skip the source
  // fetch and silently drop real issues.
  const comparesSource = new Set([
    "terminal_punctuation_mismatch",
    "missing_placeholders",
    "extra_placeholders",
    "missing_tags",
    "extra_tags",
  ]);

  for (const type of ISSUE_TYPES) {
    assert.equal(
      requiresSourceValues(new Set([type])),
      comparesSource.has(type),
      `${type} disagrees on whether it needs the source`
    );
  }

  // Any comparison rule in the set is enough to keep the fetch.
  assert.equal(requiresSourceValues(new Set(["dash_style", "missing_tags"])), true);
  // Without a type filter every rule in the scope may run, and every scope holds
  // at least one comparison rule — 'style' through terminal_punctuation_mismatch.
  for (const scope of ["all", "style", "syntax"] as const) {
    assert.equal(requiresSourceValues(resolveAuditTypes(scope)), true, scope);
  }
});

test("ISSUE_TYPES covers every rule detectTranslationIssues can emit", () => {
  // The types filter accepts exactly ISSUE_TYPES, so a rule missing from it
  // would be unfilterable.
  const emitted = [
    ...detectTranslationIssues(" Tere  ,", "Hello!", "en"),
    ...detectTranslationIssues("Tere {{a}} <b>x", "Hello {{b}} <i>x</i>", "en"),
    ...detectTranslationIssues("Tere... don't \"x\" ( y ) 1-2 a—b", "Hello", "en"),
    ...detectTranslationIssues("Bonjour « x » \"y\"", "Hello", "fr"),
  ].map((issue) => issue.type);

  assert.equal(emitted.length > 0, true);
  for (const type of emitted) {
    assert.equal(ISSUE_TYPES.includes(type), true, `${type} is missing from ISSUE_TYPES`);
  }
});

// The client throws plain Errors whose message carries the status code.
function apiError(status: number): Error {
  return new Error(`Request failed with status code ${status}: Failure`);
}

test("a write retries only the failure that proves nothing was written", () => {
  // A 429 is a refusal, so the import never reached Localazy and repeating it
  // is safe. Everything else leaves the outcome unknown: the import may have
  // been accepted and only the response lost.
  assert.equal(isRetryable(apiError(429), "write"), true);

  assert.equal(isRetryable(apiError(500), "write"), false);
  assert.equal(isRetryable(apiError(502), "write"), false);
  assert.equal(isRetryable(new Error("socket hang up"), "write"), false);
  assert.equal(isRetryable(apiError(404), "write"), false);
});

test("a read retries anything transient, because repeating it changes nothing", () => {
  assert.equal(isRetryable(apiError(429), "read"), true);
  assert.equal(isRetryable(apiError(500), "read"), true);
  assert.equal(isRetryable(apiError(502), "read"), true);
  assert.equal(isRetryable(new Error("socket hang up"), "read"), true);

  // A 4xx other than 429 is the caller's fault and will fail the same way again.
  assert.equal(isRetryable(apiError(404), "read"), false);
  assert.equal(isRetryable(apiError(401), "read"), false);
});

test("withWriteRetry sends an import once when the outcome is unknown", async () => {
  // The failure that matters: Localazy may have accepted the import and lost
  // the response. A second attempt would spend another of the 100 daily
  // imports and could overwrite an edit made in between.
  for (const error of [apiError(500), new Error("socket hang up")]) {
    let calls = 0;
    await assert.rejects(() =>
      withWriteRetry(() => {
        calls++;
        return Promise.reject(error);
      })
    );
    assert.equal(calls, 1, `${error.message} must not be retried`);
  }
});

test("withRetry gives up immediately on an error that will not change", async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetry(() => {
      calls++;
      return Promise.reject(apiError(404));
    })
  );

  assert.equal(calls, 1);
});

test("an upload stops an in-flight read from caching pre-upload values", async () => {
  invalidateCache();

  let finish!: (value: string) => void;
  const read = cached("race:flat", () => new Promise<string>((r) => { finish = r; }));

  // The upload lands while the read is still out.
  invalidateCache();
  finish("before-upload");

  // The caller that asked first still gets its answer: it read before the
  // upload, and cancelling that is not this cache's job.
  assert.equal(await read, "before-upload");

  // The cache must not keep it, or the next reader sees pre-upload data.
  assert.equal(apiCache.get("race:flat"), undefined);
});

test("a read after an upload does not join a request that predates it", async () => {
  invalidateCache();

  let finish!: (value: string) => void;
  const before = cached("race:join", () => new Promise<string>((r) => { finish = r; }));

  invalidateCache();
  const after = cached("race:join", () => Promise.resolve("after-upload"));

  finish("before-upload");

  assert.equal(await before, "before-upload");
  assert.equal(await after, "after-upload", "the later read must not be served stale work");
  assert.equal(apiCache.get("race:join"), "after-upload");
});

test("singleflight still shares one request when nothing invalidates", async () => {
  invalidateCache();

  let calls = 0;
  const fetch = () => {
    calls++;
    return Promise.resolve("value");
  };

  const [a, b] = await Promise.all([cached("race:share", fetch), cached("race:share", fetch)]);

  assert.equal(a, "value");
  assert.equal(b, "value");
  assert.equal(calls, 1, "concurrent readers of one key share a single call");
});
