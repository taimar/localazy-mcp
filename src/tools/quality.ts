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
const TERMINAL_PUNCTUATION_PATTERN = /([.!?:;…]+)$/u;
const SPACE_BEFORE_PUNCTUATION_PATTERN = /([\s\u00A0\u202F]+)([!?:;,.])/gu;
const FRENCH_ALLOWED_SPACED_PUNCTUATION = new Set(["!", "?", ":", ";"]);

type IssueType =
  | "double_spaces"
  | "leading_or_trailing_whitespace"
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

  const withoutClosers = text.trim().replace(TRAILING_CLOSERS_PATTERN, "");
  const match = withoutClosers.match(TERMINAL_PUNCTUATION_PATTERN);
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

export function detectTranslationIssues(
  targetText: string,
  sourceText: string | undefined,
  lang = "en",
): Array<{ type: IssueType; message: string }> {
  const issues: Array<{ type: IssueType; message: string }> = [];

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

    if ((sourcePunctuation || targetPunctuation) && sourcePunctuation !== targetPunctuation) {
      issues.push({
        type: "terminal_punctuation_mismatch",
        message: `Source ends with '${sourcePunctuation || "(none)"}' but target ends with '${targetPunctuation || "(none)"}'.`,
      });
    }
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
          leading_or_trailing_whitespace: 0,
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
