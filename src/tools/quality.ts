import { McpServer } from "@modelcontextprotocol/server";
import type { File } from "@localazy/api-client";
import { z } from "zod";
import { FILE_CONCURRENCY } from "../constants.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse, READ_ONLY_ANNOTATIONS } from "../lib/response.js";
import {
  assertProjectLanguage,
  buildFileLabels,
  getSourceLang,
  listFlatTranslations,
  resolveProjectFiles,
} from "../lib/translations.js";
import { localazyLocaleSchema } from "../types.js";

const MAX_RETURNED_ISSUES = 200;

// Character-class fragments shared between a rule and the guard that fronts it.
// Building both from one fragment stops a guard from ever being narrower than
// its rule, which would silently stop that rule from firing.
const SPACE = "[\\s\\u00A0\\u202F]";
const CLOSERS = `)\\]"'»”’`;
const SPACED_PUNCTUATION = "!?:;,.";

const TRAILING_CLOSERS_PATTERN = new RegExp(`[${CLOSERS}]+$`, "u");
const TRAILING_TAG_PATTERN = /(?:<\/(?:[A-Za-z][A-Za-z0-9-]*|\d+)>|<(?:[A-Za-z][A-Za-z0-9-]*|\d+)(?:\s[^<>]*?)?\s*\/>)\s*$/u;
const TERMINAL_PUNCTUATION_PATTERN = /([.!?:;…]+)$/u;
const SPACE_BEFORE_PUNCTUATION_PATTERN = new RegExp(`(${SPACE}+)([${SPACED_PUNCTUATION}])`, "gu");
const FRENCH_ALLOWED_SPACED_PUNCTUATION = new Set(["!", "?", ":", ";"]);
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const TAG_PATTERN = /<\/?([A-Za-z][A-Za-z0-9-]*|\d+)(?:\s[^<>]*?)?\/?>/gu;
const STRAIGHT_APOSTROPHE_PATTERN = /(?<=[\p{L}\p{N}\}])'(?=\p{L})/u;
const FRENCH_NON_GUILLEMET_QUOTES_PATTERN = /["“”]/u;
const CURLY_QUOTE_INNER_SPACE_PATTERN = new RegExp(
  `(?:“${SPACE}|${SPACE}”|„${SPACE}|${SPACE}“)`, "u");
const NON_FRENCH_GUILLEMET_INNER_SPACE_PATTERN = new RegExp(
  `(?:«${SPACE}|${SPACE}»|»${SPACE}|${SPACE}«)`, "u");
const PARENTHESIS_INNER_SPACE_PATTERN = /(?:\(\s|\s\))/u;
const NUMERIC_RANGE_SEGMENT_PATTERN = /\d+\s*[-–—]\s*\d+/gu;
const NON_EN_DASH_RANGE_PATTERN = /\d+(?:\s*[-—]\s*|\s+–\s*|\s*–\s+)\d+/u;
const NON_EN_DASH_SPACED_PATTERN = /\s(?:-|—)\s/u;
const NON_FRENCH_UNSPACED_EM_DASH_PATTERN = /\S—\S/u;
const WHITESPACE_CHARACTER_PATTERN = /\s/u;
const DOUBLE_SPACE_PATTERN = / {2,}/u;

// Fast-path guards. A project audit runs every rule over every translated
// value, so most of the work is proving that a rule does not apply. Each guard
// below fronts a scan that costs materially more than the guard itself.
const GUARD_SPACE_BEFORE_PUNCTUATION = new RegExp(`${SPACE}[${SPACED_PUNCTUATION}]`, "u");
const GUARD_STRIPPABLE_TAIL = new RegExp(`[${CLOSERS}>]$`, "u");
const GUARD_QUOTE_CHARACTER = /["«»“”„]/u;
const GUARD_DASH_CHARACTER = /[-–—]/u;

type IssueType =
  | "apostrophe_style"
  | "dash_style"
  | "double_spaces"
  | "ellipsis_style"
  | "extra_placeholders"
  | "extra_tags"
  | "french_guillemet_spacing"
  | "french_quote_style"
  | "invalid_tag_structure"
  | "leading_or_trailing_whitespace"
  | "missing_placeholders"
  | "missing_tags"
  | "parenthesis_inner_spacing"
  | "quote_balance"
  | "quote_inner_spacing"
  | "space_before_punctuation"
  | "terminal_punctuation_mismatch";

const auditScopeSchema = z.enum(["all", "style", "syntax"]);

type AuditScope = z.infer<typeof auditScopeSchema>;

type DetectedIssue = { type: IssueType; message: string };

type AuditIssue = DetectedIssue & {
  fileId: string;
  key: string;
  targetValue: string;
  sourceValue?: string;
};

/**
 * Every rule an audit can report: the scope it belongs to, and whether its
 * verdict depends on the source string.
 *
 * Both facts live in one table because a separate set of source-comparing rules
 * falls out of step silently. A rule missing from such a set makes the audit skip
 * the source fetch, and the rule then reports nothing at all. Here a new rule
 * cannot be added without answering both questions.
 *
 * Only a `needsSource` rule carries a `source_value` in the response. The rest
 * are target-intrinsic, so repeating the source would add bulk without adding
 * information.
 */
const RULES: Record<IssueType, { scope: Exclude<AuditScope, "all">; needsSource?: true }> = {
  apostrophe_style: { scope: "style" },
  dash_style: { scope: "style" },
  double_spaces: { scope: "style" },
  ellipsis_style: { scope: "style" },
  extra_placeholders: { scope: "syntax", needsSource: true },
  extra_tags: { scope: "syntax", needsSource: true },
  french_guillemet_spacing: { scope: "style" },
  french_quote_style: { scope: "style" },
  invalid_tag_structure: { scope: "syntax" },
  leading_or_trailing_whitespace: { scope: "style" },
  missing_placeholders: { scope: "syntax", needsSource: true },
  missing_tags: { scope: "syntax", needsSource: true },
  parenthesis_inner_spacing: { scope: "style" },
  quote_balance: { scope: "style" },
  quote_inner_spacing: { scope: "style" },
  space_before_punctuation: { scope: "style" },
  terminal_punctuation_mismatch: { scope: "style", needsSource: true },
};

// Derived from RULES so the accepted values cannot drift from the rules: RULES is
// a Record over IssueType, so a new type must be added there.
export const ISSUE_TYPES = Object.keys(RULES) as [IssueType, ...IssueType[]];

const issueTypeSchema = z.enum(ISSUE_TYPES);

function normalizeTerminalPunctuation(text?: string): string {
  if (!text) return "";

  let visibleTail = text.trim();

  // Only strip when something strippable is actually at the end; the loop
  // below runs two regex replaces per pass.
  while (GUARD_STRIPPABLE_TAIL.test(visibleTail)) {
    const stripped = visibleTail
      .replace(TRAILING_CLOSERS_PATTERN, "")
      .replace(TRAILING_TAG_PATTERN, "")
      .trimEnd();

    if (stripped === visibleTail) {
      break;
    }

    visibleTail = stripped;
  }

  const match = visibleTail.match(TERMINAL_PUNCTUATION_PATTERN);
  return match ? match[1].replace(/\.{3}/g, "…") : "";
}

function isFrenchLocale(lang: string): boolean {
  return lang === "fr" || lang.startsWith("fr_") || lang.startsWith("fr#");
}

function hasInvalidSpaceBeforePunctuation(targetText: string, isFrench: boolean): boolean {
  if (!GUARD_SPACE_BEFORE_PUNCTUATION.test(targetText)) {
    return false;
  }

  // Outside French every match is a violation, so the guard is the answer and
  // the walk below can be skipped.
  if (!isFrench) {
    return true;
  }

  for (const [, , punctuation] of targetText.matchAll(SPACE_BEFORE_PUNCTUATION_PATTERN)) {
    if (!FRENCH_ALLOWED_SPACED_PUNCTUATION.has(punctuation)) {
      return true;
    }
  }

  return false;
}

function extractPlaceholders(text: string): string[] {
  if (!text.includes("{{")) return [];
  return Array.from(text.matchAll(PLACEHOLDER_PATTERN), (match) => `{{${match[1]!.trim()}}}`);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function diffTokenCounts(
  sourceCounts: Map<string, number>,
  targetCounts: Map<string, number>,
): Array<{ token: string; count: number }> {
  const diff: Array<{ token: string; count: number }> = [];

  for (const [token, sourceCount] of sourceCounts) {
    const count = sourceCount - (targetCounts.get(token) ?? 0);
    if (count > 0) {
      diff.push({ token, count });
    }
  }

  return diff.sort((a, b) => a.token.localeCompare(b.token));
}

function formatTokenList(items: Array<{ token: string; count: number }>): string {
  return items
    .map(({ token, count }) => count === 1 ? token : `${token} x${count}`)
    .join(", ");
}

function pushTokenDiffIssues(
  issues: DetectedIssue[],
  sourceTokens: string[],
  targetTokens: string[],
  missingType: "missing_placeholders" | "missing_tags",
  extraType: "extra_placeholders" | "extra_tags",
  label: "placeholders" | "tags",
): void {
  if (sourceTokens.length === 0 && targetTokens.length === 0) {
    return;
  }

  const sourceCounts = countTokens(sourceTokens);
  const targetCounts = countTokens(targetTokens);
  const missingTokens = diffTokenCounts(sourceCounts, targetCounts);
  const extraTokens = diffTokenCounts(targetCounts, sourceCounts);

  if (missingTokens.length > 0) {
    issues.push({
      type: missingType,
      message: `Target is missing ${label}: ${formatTokenList(missingTokens)}.`,
    });
  }

  if (extraTokens.length > 0) {
    issues.push({
      type: extraType,
      message: `Target has extra ${label}: ${formatTokenList(extraTokens)}.`,
    });
  }
}

type TagAnalysis = {
  tokens: string[];
  structureError: string | null;
};

function analyzeTags(text: string): TagAnalysis {
  if (!text.includes("<")) return { tokens: [], structureError: null };

  const tokens: string[] = [];
  const stack: string[] = [];

  for (const match of text.matchAll(TAG_PATTERN)) {
    const raw = match[0]!;
    const name = match[1]!;
    const isClosingTag = raw.startsWith("</");
    const isSelfClosingTag = raw.endsWith("/>");

    if (isClosingTag) {
      const expected = stack.pop();

      if (expected === undefined) {
        return {
          tokens,
          structureError: `Target has invalid tag structure: unexpected closing tag </${name}>.`,
        };
      }

      if (expected !== name) {
        return {
          tokens,
          structureError: `Target has invalid tag structure: expected </${expected}> but found </${name}>.`,
        };
      }

      continue;
    }

    tokens.push(isSelfClosingTag ? `<${name}/>` : `<${name}>`);

    if (!isSelfClosingTag) {
      stack.push(name);
    }
  }

  if (stack.length > 0) {
    return {
      tokens,
      structureError: `Target has invalid tag structure: missing closing tag for <${stack[stack.length - 1]!}>.`,
    };
  }

  return { tokens, structureError: null };
}

function getStyleText(text: string): string {
  return text.includes("<") ? text.replace(TAG_PATTERN, "") : text;
}

function isWhitespaceCharacter(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE_CHARACTER_PATTERN.test(char);
}

function isFrenchGuillemetSpace(char: string | undefined): boolean {
  return char === "\u00A0" || char === "\u202F";
}

function hasInvalidFrenchGuillemetSpacing(text: string): boolean {
  for (let i = text.indexOf("«"); i !== -1; i = text.indexOf("«", i + 1)) {
    const next = text[i + 1];
    if (isWhitespaceCharacter(next) && !isFrenchGuillemetSpace(next)) return true;
  }

  for (let i = text.indexOf("»"); i !== -1; i = text.indexOf("»", i + 1)) {
    const previous = text[i - 1];
    if (isWhitespaceCharacter(previous) && !isFrenchGuillemetSpace(previous)) return true;
  }

  return false;
}

function hasMixedEmDashSpacing(text: string): boolean {
  for (let index = text.indexOf("—"); index !== -1; index = text.indexOf("—", index + 1)) {
    const hasLeftSpace = isWhitespaceCharacter(text[index - 1]);
    const hasRightSpace = isWhitespaceCharacter(text[index + 1]);

    if (hasLeftSpace !== hasRightSpace) {
      return true;
    }
  }

  return false;
}

function getQuoteBalanceIssue(text: string): string | null {
  if (!GUARD_QUOTE_CHARACTER.test(text)) return null;

  let straightDoubleQuoteCount = 0;
  const stack: Array<"«" | "“" | "„"> = [];

  for (const char of text) {
    if (char === "\"") {
      straightDoubleQuoteCount++;
      continue;
    }

    if (char === "“") {
      if (stack[stack.length - 1] === "„") {
        stack.pop();
      } else {
        stack.push(char);
      }
      continue;
    }

    if (char === "«" || char === "„") {
      stack.push(char);
      continue;
    }

    if (char === "»") {
      if (stack.pop() !== "«") {
        return "Target has unbalanced quotation marks.";
      }
      continue;
    }

    if (char === "”") {
      if (stack.pop() !== "“") {
        return "Target has unbalanced quotation marks.";
      }
    }
  }

  if (straightDoubleQuoteCount % 2 !== 0 || stack.length > 0) {
    return "Target has unbalanced quotation marks.";
  }

  return null;
}

function getDashStyleIssues(text: string, isFrench: boolean): DetectedIssue[] {
  if (!GUARD_DASH_CHARACTER.test(text)) return [];

  const issues: DetectedIssue[] = [];
  // Numeric ranges are checked on their own; blank them out so they cannot
  // also trip the sentence-dash rules.
  const withoutRanges = text.replaceAll(NUMERIC_RANGE_SEGMENT_PATTERN, " ");

  if (NON_EN_DASH_RANGE_PATTERN.test(text)) {
    issues.push({
      type: "dash_style",
      message: "Use an en dash for numeric ranges (for example '1–2').",
    });
  }

  if (!isFrench && NON_EN_DASH_SPACED_PATTERN.test(withoutRanges)) {
    issues.push({
      type: "dash_style",
      message: "Use an en dash for spaced dashes (for example ' – ').",
    });
  }

  if (!isFrench && NON_FRENCH_UNSPACED_EM_DASH_PATTERN.test(withoutRanges)) {
    issues.push({
      type: "dash_style",
      message: "Use a spaced en dash for sentence dashes (for example ' – ').",
    });
  }

  if (hasMixedEmDashSpacing(withoutRanges)) {
    issues.push({
      type: "dash_style",
      message: "Em dashes should have either spaces on both sides or no spaces on either side.",
    });
  }

  return issues;
}

function getQuoteInnerSpacingIssue(text: string, isFrench: boolean): string | null {
  if (!GUARD_QUOTE_CHARACTER.test(text)) return null;

  if (CURLY_QUOTE_INNER_SPACE_PATTERN.test(text)) {
    return "Curly or directional quotes should not have spaces directly inside the quote marks.";
  }

  if (!isFrench && NON_FRENCH_GUILLEMET_INNER_SPACE_PATTERN.test(text)) {
    return "Non-French guillemets should not have spaces directly inside the quote marks.";
  }

  return null;
}

function getParenthesisInnerSpacingIssue(text: string): string | null {
  if (PARENTHESIS_INNER_SPACE_PATTERN.test(text)) {
    return "Parentheses should not have spaces directly inside them.";
  }

  return null;
}

/**
 * Whether any rule in `types` needs the source string.
 *
 * Scope alone can never answer this — `terminal_punctuation_mismatch` is a
 * style rule that compares against the source — but an explicit type filter
 * often can, and skipping the source halves the requests a scan makes. The
 * fetch, not the regex work, is what a project scan spends its time on.
 */
export function requiresSourceValues(types: Set<IssueType>): boolean {
  for (const type of types) {
    if (RULES[type].needsSource) return true;
  }

  return false;
}

/**
 * The exact set of rules an audit will report.
 *
 * Scope and the optional type list resolve into one set here, so everything
 * downstream asks a single membership question instead of re-deriving how the two
 * inputs combine. Scope stays authoritative: `requested` can only remove a rule,
 * never add one the scope excludes.
 *
 * An empty intersection is refused rather than served. Such an audit scans every
 * file and reports zero issues, which reads as a clean language instead of as a
 * filter that excludes everything.
 */
export function resolveAuditTypes(scope: AuditScope, requested?: IssueType[]): Set<IssueType> {
  const inScope = new Set(
    ISSUE_TYPES.filter((type) => scope === "all" || RULES[type].scope === scope)
  );

  if (!requested?.length) return inScope;

  const narrowed = requested.filter((type) => inScope.has(type));

  if (narrowed.length === 0) {
    const requestedScopes = [...new Set(requested.map((type) => RULES[type].scope))].sort();
    throw new Error(
      `no requested type belongs to scope '${scope}'. ` +
      `${requested.join(", ")} — ${requestedScopes.join(" and ")}. ` +
      `Use scope 'all', or '${requestedScopes[0]}'.`
    );
  }

  return new Set(narrowed);
}

export function detectTranslationIssues(
  targetText: string,
  sourceText: string | undefined,
  lang = "en",
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const isFrench = isFrenchLocale(lang);
  const targetTagAnalysis = analyzeTags(targetText);
  const styleText = getStyleText(targetText);

  if (targetText.trim() !== targetText) {
    issues.push({
      type: "leading_or_trailing_whitespace",
      message: "Target has leading or trailing whitespace.",
    });
  }

  if (DOUBLE_SPACE_PATTERN.test(targetText)) {
    issues.push({
      type: "double_spaces",
      message: "Target contains consecutive spaces.",
    });
  }

  if (hasInvalidSpaceBeforePunctuation(targetText, isFrench)) {
    issues.push({
      type: "space_before_punctuation",
      message: "Target has a space immediately before punctuation.",
    });
  }

  if (styleText.includes("...")) {
    issues.push({
      type: "ellipsis_style",
      message: "Target uses '...' instead of the ellipsis character '…'.",
    });
  }

  if (styleText.includes("'") && STRAIGHT_APOSTROPHE_PATTERN.test(styleText)) {
    issues.push({
      type: "apostrophe_style",
      message: "Use curly apostrophes (’) instead of straight apostrophes in contractions and possessives.",
    });
  }

  const quoteBalanceIssue = getQuoteBalanceIssue(styleText);
  if (quoteBalanceIssue) {
    issues.push({
      type: "quote_balance",
      message: quoteBalanceIssue,
    });
  }

  const quoteInnerSpacingIssue = getQuoteInnerSpacingIssue(styleText, isFrench);
  if (quoteInnerSpacingIssue) {
    issues.push({
      type: "quote_inner_spacing",
      message: quoteInnerSpacingIssue,
    });
  }

  const parenthesisInnerSpacingIssue = getParenthesisInnerSpacingIssue(styleText);
  if (parenthesisInnerSpacingIssue) {
    issues.push({
      type: "parenthesis_inner_spacing",
      message: parenthesisInnerSpacingIssue,
    });
  }

  if (isFrench && FRENCH_NON_GUILLEMET_QUOTES_PATTERN.test(styleText)) {
    issues.push({
      type: "french_quote_style",
      message: "French text should use guillemets (« ») instead of straight or curly double quotes.",
    });
  }

  if (isFrench && hasInvalidFrenchGuillemetSpacing(styleText)) {
    issues.push({
      type: "french_guillemet_spacing",
      message: "Spaces inside French guillemets should use a non-breaking or narrow non-breaking space.",
    });
  }

  issues.push(...getDashStyleIssues(styleText, isFrench));

  if (sourceText !== undefined) {
    const sourcePunctuation = normalizeTerminalPunctuation(sourceText);
    const targetPunctuation = normalizeTerminalPunctuation(targetText);
    const sourceTagAnalysis = analyzeTags(sourceText);

    if ((sourcePunctuation || targetPunctuation) && sourcePunctuation !== targetPunctuation) {
      issues.push({
        type: "terminal_punctuation_mismatch",
        message: `Source ends with '${sourcePunctuation || "(none)"}' but target ends with '${targetPunctuation || "(none)"}'.`,
      });
    }

    pushTokenDiffIssues(
      issues,
      extractPlaceholders(sourceText),
      extractPlaceholders(targetText),
      "missing_placeholders",
      "extra_placeholders",
      "placeholders",
    );
    pushTokenDiffIssues(
      issues,
      sourceTagAnalysis.tokens,
      targetTagAnalysis.tokens,
      "missing_tags",
      "extra_tags",
      "tags",
    );
  }

  if (targetTagAnalysis.structureError) {
    issues.push({
      type: "invalid_tag_structure",
      message: targetTagAnalysis.structureError,
    });
  }

  return issues;
}

type FileAudit = {
  issues: AuditIssue[];
  countsByType: Map<IssueType, number>;
  scannedValueCount: number;
};

/** Everything a per-file audit needs, decided once for the whole scan. */
type AuditPlan = {
  projectId: string;
  lang: string;
  sourceLang: string;
  types: Set<IssueType>;
  /** Whether the source language is fetched and compared at all. */
  comparesSource: boolean;
};

async function auditFile(plan: AuditPlan, file: File): Promise<FileAudit> {
  const { projectId, lang, sourceLang, types, comparesSource } = plan;
  const [targetEntries, sourceEntries] = await Promise.all([
    listFlatTranslations(projectId, file.id, lang),
    comparesSource ? listFlatTranslations(projectId, file.id, sourceLang) : [],
  ]);

  const sourceMap = new Map<string, string>();
  for (const entry of sourceEntries) {
    sourceMap.set(entry.key, entry.text);
  }

  const issues: AuditIssue[] = [];
  const countsByType = new Map<IssueType, number>();

  for (const entry of targetEntries) {
    const sourceValue = comparesSource ? sourceMap.get(entry.key) : undefined;

    for (const issue of detectTranslationIssues(entry.text, sourceValue, lang)) {
      if (!types.has(issue.type)) {
        continue;
      }

      countsByType.set(issue.type, (countsByType.get(issue.type) ?? 0) + 1);

      // Each file keeps at most a full response's worth; the merge step below
      // trims to the global cap.
      if (issues.length < MAX_RETURNED_ISSUES) {
        issues.push({
          type: issue.type,
          message: issue.message,
          fileId: file.id,
          key: entry.key,
          targetValue: entry.text,
          ...(sourceValue !== undefined && RULES[issue.type].needsSource
            ? { sourceValue }
            : {}),
        });
      }
    }
  }

  return { issues, countsByType, scannedValueCount: targetEntries.length };
}

type SerializedAuditIssue = {
  type: IssueType;
  file_id: string;
  key: string;
  message?: string;
  target_value: string;
  source_value?: string;
};

/**
 * Hoist a rule's message into a legend so its issues can omit it. Most rules
 * emit one fixed sentence that would otherwise repeat verbatim per occurrence.
 *
 * Only types whose every issue shares the same message are promoted. Rules with
 * parameterized messages (a specific punctuation pair, a list of placeholders)
 * are left inline: hoisting one of them would read as the rule for the type
 * while actually describing a single occurrence.
 */
function buildRuleLegend(issues: AuditIssue[]): Record<string, string> {
  const messagesByType = new Map<IssueType, string | null>();

  for (const issue of issues) {
    const seen = messagesByType.get(issue.type);
    if (seen === undefined) {
      messagesByType.set(issue.type, issue.message);
    } else if (seen !== null && seen !== issue.message) {
      messagesByType.set(issue.type, null); // varies — not a fixed rule
    }
  }

  const legend: Record<string, string> = {};

  for (const [type, message] of messagesByType) {
    if (message !== null) legend[type] = message;
  }

  return legend;
}

/**
 * Encode issues for the response: a fixed per-type message moves into `rules`,
 * and issues of that type drop it. Every issue's message stays recoverable as
 * `message ?? rules[type]`.
 */
export function serializeAuditIssues(issues: AuditIssue[]): {
  issues: SerializedAuditIssue[];
  rules: Record<string, string>;
} {
  const rules = buildRuleLegend(issues);

  return {
    rules,
    issues: issues.map((issue) => ({
      type: issue.type,
      file_id: issue.fileId,
      key: issue.key,
      ...(issue.message === rules[issue.type] ? {} : { message: issue.message }),
      target_value: issue.targetValue,
      ...(issue.sourceValue !== undefined ? { source_value: issue.sourceValue } : {}),
    })),
  };
}

async function auditTranslations(lang: string, scope: AuditScope, types?: IssueType[]) {
  try {
    // Resolved before any request, so a filter that excludes everything is
    // refused without first paying for the project and file lookups.
    const auditTypes = resolveAuditTypes(scope, types);

    const { project, files } = await resolveProjectFiles();
    assertProjectLanguage(project, lang);

    const sourceLang = getSourceLang(project);
    const plan: AuditPlan = {
      projectId: project.id,
      lang,
      sourceLang,
      types: auditTypes,
      // Skip fetching the source when it cannot change the result: auditing the
      // source language against itself only reports target-intrinsic issues, and
      // a type filter may exclude every rule that compares the two.
      comparesSource: sourceLang !== lang && requiresSourceValues(auditTypes),
    };

    const fileAudits = await mapWithConcurrency(files, FILE_CONCURRENCY, (file) =>
      auditFile(plan, file)
    );

    const countsByType = new Map<IssueType, number>();
    const issues: AuditIssue[] = [];
    let scannedValueCount = 0;

    for (const audit of fileAudits) {
      scannedValueCount += audit.scannedValueCount;
      for (const [type, count] of audit.countsByType) {
        countsByType.set(type, (countsByType.get(type) ?? 0) + count);
      }
      for (const issue of audit.issues) {
        if (issues.length >= MAX_RETURNED_ISSUES) break;
        issues.push(issue);
      }
    }

    const issueCount = [...countsByType.values()].reduce((total, count) => total + count, 0);
    const { issues: serialized, rules } = serializeAuditIssues(issues);

    return jsonResponseArray(
      serialized,
      "issues",
      {
        project_name: project.name,
        lang,
        scope,
        // The effective list, so a type dropped for being outside the scope is
        // visible rather than silently absent.
        ...(types?.length ? { types: [...auditTypes] } : {}),
        source_lang: sourceLang,
        file_count: files.length,
        scanned_value_count: scannedValueCount,
        issue_count: issueCount,
        limited: issueCount > issues.length,
        counts_by_type: Object.fromEntries(countsByType),
        files: buildFileLabels(files, new Set(issues.map((issue) => issue.fileId))),
        rules,
      },
      `Response contains the first ${MAX_RETURNED_ISSUES} issues. Inspect files manually if you need the full list.`
    );
  } catch (error) {
    return errorResponse(handleError(error));
  }
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_audit_translations",
    {
      title: "Audit Translations",
      description: `Audit a language for translation QA issues in one call, across every file in the project.

Use for "Audit ET translations", "Audit FR style", "Audit ET syntax", "Which ET strings use straight apostrophes".

Each issue carries \`type\`, \`file_id\`, \`key\` and \`target_value\`. Read its message as \`message ?? rules[type]\` — fixed rule text lives once in \`rules\`, and only per-occurrence messages are inline. Resolve \`file_id\` via the \`files\` map. \`source_value\` is present only for rules that compare against the source.`,
      inputSchema: z.object({
        lang: localazyLocaleSchema
          .default("en")
          .describe("Language code to inspect, for example 'et'"),
        scope: auditScopeSchema
          .default("all")
          .describe("'style' (punctuation, quotes, dashes, spacing), 'syntax' (placeholders, tags), or 'all'"),
        types: z
          .array(issueTypeSchema)
          .min(1)
          .optional()
          .describe("Report only these issue types. Narrows 'scope' and cannot widen it"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ lang, scope, types }) => auditTranslations(lang, scope, types)
  );
}
