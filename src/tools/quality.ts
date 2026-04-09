import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse } from "../lib/response.js";
import {
  flattenTranslations,
  formatFileLabel,
  getSourceLang,
  listAllKeys,
  resolveFiles,
  resolveProject,
} from "../lib/translations.js";
import { localazyLocaleSchema } from "../types.js";

const MAX_RETURNED_ISSUES = 200;
const TRAILING_CLOSERS_PATTERN = /[)\]"'»”’]+$/u;
const TRAILING_TAG_PATTERN = /(?:<\/(?:[A-Za-z][A-Za-z0-9-]*|\d+)>|<(?:[A-Za-z][A-Za-z0-9-]*|\d+)(?:\s[^<>]*?)?\s*\/>)\s*$/u;
const TERMINAL_PUNCTUATION_PATTERN = /([.!?:;…]+)$/u;
const SPACE_BEFORE_PUNCTUATION_PATTERN = /([\s\u00A0\u202F]+)([!?:;,.])/gu;
const FRENCH_ALLOWED_SPACED_PUNCTUATION = new Set(["!", "?", ":", ";"]);
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const TAG_PATTERN = /<\/?([A-Za-z][A-Za-z0-9-]*|\d+)(?:\s[^<>]*?)?\/?>/gu;
const ASCII_ELLIPSIS_PATTERN = /\.{3}/u;
const STRAIGHT_APOSTROPHE_PATTERN = /(?<=[\p{L}\p{N}\}])'(?=\p{L})/u;
const FRENCH_NON_GUILLEMET_QUOTES_PATTERN = /["“”]/u;
const CURLY_QUOTE_INNER_SPACE_PATTERN = /(?:“[\s\u00A0\u202F]|[\s\u00A0\u202F]”|„[\s\u00A0\u202F]|[\s\u00A0\u202F]“)/u;
const NON_FRENCH_GUILLEMET_INNER_SPACE_PATTERN = /(?:«[\s\u00A0\u202F]|[\s\u00A0\u202F]»|»[\s\u00A0\u202F]|[\s\u00A0\u202F]«)/u;
const NUMERIC_RANGE_SEGMENT_PATTERN = /\d+\s*[-–—]\s*\d+/gu;
const NON_EN_DASH_RANGE_PATTERN = /\d+(?:\s*[-—]\s*|\s+–\s*|\s*–\s+)\d+/u;
const NON_EN_DASH_SPACED_PATTERN = /\s(?:-|—)\s/u;
const NON_FRENCH_UNSPACED_EM_DASH_PATTERN = /\S—\S/u;
const WHITESPACE_CHARACTER_PATTERN = /\s/u;

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
  | "quote_balance"
  | "quote_inner_spacing"
  | "space_before_punctuation"
  | "terminal_punctuation_mismatch";

type AuditIssue = {
  type: IssueType;
  file: string;
  file_id: string;
  key: string;
  message: string;
  target_value: string;
  source_value?: string;
};

function normalizeTerminalPunctuation(text?: string): string {
  if (!text) return "";

  let visibleTail = text.trim();

  while (true) {
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

function hasInvalidSpaceBeforePunctuation(targetText: string, lang: string): boolean {
  for (const [, , punctuation] of targetText.matchAll(SPACE_BEFORE_PUNCTUATION_PATTERN)) {
    if (isFrenchLocale(lang) && FRENCH_ALLOWED_SPACED_PUNCTUATION.has(punctuation)) {
      continue;
    }

    return true;
  }

  return false;
}

function extractPlaceholders(text: string): string[] {
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
  issues: Array<{ type: IssueType; message: string }>,
  sourceTokens: string[],
  targetTokens: string[],
  missingType: "missing_placeholders" | "missing_tags",
  extraType: "extra_placeholders" | "extra_tags",
  label: "placeholders" | "tags",
): void {
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
  return text.replace(TAG_PATTERN, "");
}

function isWhitespaceCharacter(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE_CHARACTER_PATTERN.test(char);
}

function isFrenchGuillemetSpace(char: string | undefined): boolean {
  return char === "\u00A0" || char === "\u202F";
}

function hasInvalidFrenchGuillemetSpacing(text: string): boolean {
  const chars = Array.from(text);

  for (const [index, char] of chars.entries()) {
    if (char === "«") {
      const next = chars[index + 1];
      if (isWhitespaceCharacter(next) && !isFrenchGuillemetSpace(next)) {
        return true;
      }
      continue;
    }

    if (char === "»") {
      const previous = chars[index - 1];
      if (isWhitespaceCharacter(previous) && !isFrenchGuillemetSpace(previous)) {
        return true;
      }
    }
  }

  return false;
}

function hasMixedEmDashSpacing(text: string): boolean {
  const chars = Array.from(text);

  for (const [index, char] of chars.entries()) {
    if (char !== "—") {
      continue;
    }

    const hasLeftSpace = isWhitespaceCharacter(chars[index - 1]);
    const hasRightSpace = isWhitespaceCharacter(chars[index + 1]);

    if (hasLeftSpace !== hasRightSpace) {
      return true;
    }
  }

  return false;
}

function getQuoteBalanceIssue(text: string): string | null {
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

function getDashStyleIssues(text: string, lang: string): Array<{ type: IssueType; message: string }> {
  const issues: Array<{ type: IssueType; message: string }> = [];
  const withoutRanges = text.replaceAll(NUMERIC_RANGE_SEGMENT_PATTERN, " ");

  if (NON_EN_DASH_RANGE_PATTERN.test(text)) {
    issues.push({
      type: "dash_style",
      message: "Use an en dash for numeric ranges (for example '1–2').",
    });
  }

  if (!isFrenchLocale(lang) && NON_EN_DASH_SPACED_PATTERN.test(withoutRanges)) {
    issues.push({
      type: "dash_style",
      message: "Use an en dash for spaced dashes (for example ' – ').",
    });
  }

  if (!isFrenchLocale(lang) && NON_FRENCH_UNSPACED_EM_DASH_PATTERN.test(withoutRanges)) {
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

function getQuoteInnerSpacingIssue(text: string, lang: string): string | null {
  if (CURLY_QUOTE_INNER_SPACE_PATTERN.test(text)) {
    return "Curly or directional quotes should not have spaces directly inside the quote marks.";
  }

  if (!isFrenchLocale(lang) && NON_FRENCH_GUILLEMET_INNER_SPACE_PATTERN.test(text)) {
    return "Non-French guillemets should not have spaces directly inside the quote marks.";
  }

  return null;
}

export function detectTranslationIssues(
  targetText: string,
  sourceText: string | undefined,
  lang = "en",
): Array<{ type: IssueType; message: string }> {
  const issues: Array<{ type: IssueType; message: string }> = [];
  const targetTagAnalysis = analyzeTags(targetText);
  const styleText = getStyleText(targetText);

  if (targetText.trim() !== targetText) {
    issues.push({
      type: "leading_or_trailing_whitespace",
      message: "Target has leading or trailing whitespace.",
    });
  }

  if (/ {2,}/.test(targetText)) {
    issues.push({
      type: "double_spaces",
      message: "Target contains consecutive spaces.",
    });
  }

  if (hasInvalidSpaceBeforePunctuation(targetText, lang)) {
    issues.push({
      type: "space_before_punctuation",
      message: "Target has a space immediately before punctuation.",
    });
  }

  if (ASCII_ELLIPSIS_PATTERN.test(styleText)) {
    issues.push({
      type: "ellipsis_style",
      message: "Target uses '...' instead of the ellipsis character '…'.",
    });
  }

  if (STRAIGHT_APOSTROPHE_PATTERN.test(styleText)) {
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

  const quoteInnerSpacingIssue = getQuoteInnerSpacingIssue(styleText, lang);
  if (quoteInnerSpacingIssue) {
    issues.push({
      type: "quote_inner_spacing",
      message: quoteInnerSpacingIssue,
    });
  }

  if (isFrenchLocale(lang) && FRENCH_NON_GUILLEMET_QUOTES_PATTERN.test(styleText)) {
    issues.push({
      type: "french_quote_style",
      message: "French text should use guillemets (« ») instead of straight or curly double quotes.",
    });
  }

  if (isFrenchLocale(lang) && hasInvalidFrenchGuillemetSpacing(styleText)) {
    issues.push({
      type: "french_guillemet_spacing",
      message: "Spaces inside French guillemets should use a non-breaking or narrow non-breaking space.",
    });
  }

  issues.push(...getDashStyleIssues(styleText, lang));

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

    if (targetTagAnalysis.structureError) {
      issues.push({
        type: "invalid_tag_structure",
        message: targetTagAnalysis.structureError,
      });
    }
  } else if (targetTagAnalysis.structureError) {
    issues.push({
      type: "invalid_tag_structure",
      message: targetTagAnalysis.structureError,
    });
  }

  return issues;
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_audit_translations",
    {
      title: "Audit Translations",
      description: `Audit a language for common QA issues in one call.

Use this for requests like "Check ET translations for punctuation issues and double spaces". It automatically uses the first accessible project, scans all files, compares against the project's source language, and returns matching issues.`,
      inputSchema: {
        lang: localazyLocaleSchema
          .default("en")
          .describe("Valid Localazy language code to inspect, for example 'et'"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ lang }) => {
      try {
        const project = await resolveProject();
        const files = await resolveFiles(project.id);
        const sourceLang = getSourceLang(project);

        const countsByType: Record<IssueType, number> = {
          apostrophe_style: 0,
          dash_style: 0,
          double_spaces: 0,
          ellipsis_style: 0,
          extra_placeholders: 0,
          extra_tags: 0,
          french_guillemet_spacing: 0,
          french_quote_style: 0,
          invalid_tag_structure: 0,
          leading_or_trailing_whitespace: 0,
          missing_placeholders: 0,
          missing_tags: 0,
          quote_balance: 0,
          quote_inner_spacing: 0,
          space_before_punctuation: 0,
          terminal_punctuation_mismatch: 0,
        };
        const issues: AuditIssue[] = [];
        let issueCount = 0;
        let scannedValueCount = 0;

        for (const file of files) {
          const targetKeys = await listAllKeys(project.id, file.id, lang);
          const sourceKeys = sourceLang === lang
            ? targetKeys
            : await listAllKeys(project.id, file.id, sourceLang);
          const sourceMap = new Map(
            flattenTranslations(sourceKeys).map((entry) => [entry.key, entry.text])
          );

          for (const entry of flattenTranslations(targetKeys)) {
            scannedValueCount++;

            for (const issue of detectTranslationIssues(entry.text, sourceMap.get(entry.key), lang)) {
              countsByType[issue.type]++;
              issueCount++;

              if (issues.length < MAX_RETURNED_ISSUES) {
                issues.push({
                  type: issue.type,
                  file: formatFileLabel(file),
                  file_id: file.id,
                  key: entry.key,
                  message: issue.message,
                  target_value: entry.text,
                  ...(sourceMap.has(entry.key)
                    ? { source_value: sourceMap.get(entry.key) }
                    : {}),
                });
              }
            }
          }
        }

        return jsonResponseArray(
          issues,
          "issues",
          {
            project_id: project.id,
            project_name: project.name,
            lang,
            source_lang: sourceLang,
            file_count: files.length,
            scanned_value_count: scannedValueCount,
            issue_count: issueCount,
            counts_by_type: countsByType,
            returned_count: issues.length,
            limited: issueCount > issues.length,
          },
          `Response contains the first ${MAX_RETURNED_ISSUES} issues. Inspect files manually if you need the full list.`
        );
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
