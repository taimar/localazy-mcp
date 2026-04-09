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
