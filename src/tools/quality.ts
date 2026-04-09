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

type IssueType =
  | "double_spaces"
  | "extra_placeholders"
  | "extra_tags"
  | "invalid_tag_structure"
  | "leading_or_trailing_whitespace"
  | "missing_placeholders"
  | "missing_tags"
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

export function detectTranslationIssues(
  targetText: string,
  sourceText: string | undefined,
  lang = "en",
): Array<{ type: IssueType; message: string }> {
  const issues: Array<{ type: IssueType; message: string }> = [];
  const targetTagAnalysis = analyzeTags(targetText);

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
          double_spaces: 0,
          extra_placeholders: 0,
          extra_tags: 0,
          invalid_tag_structure: 0,
          leading_or_trailing_whitespace: 0,
          missing_placeholders: 0,
          missing_tags: 0,
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
