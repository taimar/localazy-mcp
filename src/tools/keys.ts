import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheKeys, cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";
import { checkProjectLanguage, formatKeyPath, resolveProject } from "../lib/translations.js";
import { asLocale, localazyLocaleSchema } from "../types.js";
import type { Key } from "../types.js";

export function formatListKeysPageOutput(
  result: { keys: Key[]; next?: string },
  extraInfo: boolean
): {
  count: number;
  next: string | undefined;
  keys: Array<{
    id?: string;
    key: string;
    value: Key["value"];
    comment?: string;
    deprecated?: number;
    hidden?: boolean;
    limit?: number;
  }>;
} {
  return {
    count: result.keys.length,
    next: result.next,
    keys: result.keys.map((k) => ({
      ...(extraInfo ? { id: k.id } : {}),
      key: formatKeyPath(k),
      value: k.value,
      ...(extraInfo && k.comment ? { comment: k.comment } : {}),
      ...(extraInfo && k.deprecated !== undefined && k.deprecated !== -1
        ? { deprecated: k.deprecated }
        : {}),
      ...(extraInfo && k.hidden ? { hidden: k.hidden } : {}),
      ...(extraInfo && k.limit !== undefined && k.limit !== -1
        ? { limit: k.limit }
        : {}),
    })),
  };
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_keys",
    {
      title: "List Translation Keys",
      description: `Browse one page of translation keys from a single file, as { count, keys: [{ key, value, ... }], next? }. Pass \`next\` back to fetch the following page.

Use for manual paginated browsing. To search or QA the project, prefer localazy_find_translations or localazy_audit_translations.

\`prefix\` is applied after the page is fetched, so a page can come back empty while \`next\` still points at more keys.`,
      inputSchema: {
        file_id: z.string().describe("File ID from localazy_list_files"),
        lang: localazyLocaleSchema
          .default("en")
          .describe("Language code (default: en)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Max keys per page (default: 100)"),
        next: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response"),
        prefix: z
          .string()
          .optional()
          .describe("Keep only the exact dot-path and its children, e.g. 'detailViewer' keeps detailViewer and detailViewer.*"),
        extra_info: z
          .boolean()
          .default(false)
          .describe("Include key IDs, comments, deprecation, hidden flag, and length limits"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ file_id, lang, limit, next, prefix, extra_info }) => {
      try {
        const api = getClient();
        const project = await resolveProject();

        const languageError = checkProjectLanguage(project, lang);
        if (languageError) return errorResponse(languageError);

        const hint = "Use a smaller 'limit', pagination with the 'next' cursor, or a 'prefix' filter.";

        const fetchPage = async (pageLimit: number) => {
          const cacheKey = cacheKeys.keysPage(project.id, file_id, lang, pageLimit, extra_info, next);
          const result = await cached(cacheKey, () =>
            withRetry(() => api.files.listKeysPage({
              project: project.id, file: file_id, lang: asLocale(lang),
              limit: pageLimit, next, extra_info,
            }))
          );
          const output = formatListKeysPageOutput(result, extra_info);
          const keys = prefix
            ? output.keys.filter((k) => k.key === prefix || k.key.startsWith(prefix + "."))
            : output.keys;
          return { result, keys, next: output.next };
        };

        const page = await fetchPage(limit);
        const response = jsonResponseArray(
          page.keys, "keys",
          { count: page.keys.length, ...(page.next ? { next: page.next } : {}) },
          hint,
        );

        // If truncation occurred but the API had no more pages, re-fetch with
        // a reduced limit so the API returns a real `next` cursor for recovery.
        if (response._arrayMeta.truncated && !page.result.next) {
          const retry = await fetchPage(response._arrayMeta.includedCount);
          return jsonResponseArray(
            retry.keys, "keys",
            { count: retry.keys.length, ...(retry.next ? { next: retry.next } : {}) },
            hint,
          );
        }

        return response;
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
