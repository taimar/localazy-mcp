import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse, READ_ONLY_ANNOTATIONS } from "../lib/response.js";
import {
  assertProjectLanguage,
  formatKeyPath,
  listKeysPage,
  resolveProject,
} from "../lib/translations.js";
import { localazyLocaleSchema } from "../types.js";
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
      inputSchema: z.object({
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
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ file_id, lang, limit, next, prefix, extra_info }) => {
      try {
        const project = await resolveProject();
        assertProjectLanguage(project, lang);

        const hint = "Use a smaller 'limit', pagination with the 'next' cursor, or a 'prefix' filter.";

        // A cursor belongs to the entire raw API page, including keys removed
        // by prefix filtering. Only return it once all matching keys fit.
        let pageLimit = limit;
        for (;;) {
          const result = await listKeysPage({
            projectId: project.id,
            fileId: file_id,
            lang,
            limit: pageLimit,
            extraInfo: extra_info,
            cursor: next,
          });
          const output = formatListKeysPageOutput(result, extra_info);
          const keys = prefix
            ? output.keys.filter((k) => k.key === prefix || k.key.startsWith(prefix + "."))
            : output.keys;
          const response = jsonResponseArray(
            keys, "keys",
            { count: keys.length, ...(output.next ? { next: output.next } : {}) },
            hint,
          );
          if (response.isError || !response._arrayMeta.truncated) return response;
          if (pageLimit === 1) {
            return errorResponse(
              "Error: a translation key exceeds the response character budget. " +
              "Increase LOCALAZY_CHARACTER_LIMIT to read it in full. The cursor has not advanced."
            );
          }
          pageLimit = Math.max(1, Math.min(
            pageLimit - 1,
            response._arrayMeta.includedCount || Math.floor(pageLimit / 2),
          ));
        }
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
