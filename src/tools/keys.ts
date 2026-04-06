import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { asLocale, localazyLocaleSchema } from "../types.js";
import type { Key } from "../types.js";

function formatKeyPath(key: Key): string {
  return key.key.join(".");
}

export function formatListKeysPageOutput(
  result: { keys: Key[]; next?: string },
  extraInfo: boolean
): {
  count: number;
  next: string | undefined;
  keys: Array<{
    id: string;
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
      id: k.id,
      key: formatKeyPath(k),
      value: k.value,
      ...(extraInfo && k.comment !== undefined ? { comment: k.comment } : {}),
      ...(extraInfo && k.deprecated !== undefined
        ? { deprecated: k.deprecated }
        : {}),
      ...(extraInfo && k.hidden !== undefined ? { hidden: k.hidden } : {}),
      ...(extraInfo && k.limit !== undefined ? { limit: k.limit } : {}),
    })),
  };
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_keys",
    {
      title: "List Translation Keys",
      description: `List translation keys from a specific file in a Localazy project, with pagination.

Args:
  - project_id (string): Project ID
  - file_id (string): File ID from localazy_list_files
  - lang (string): Language code (default: "en")
  - limit (number): Max keys per page, 1-1000 (default: 100)
  - next (string): Pagination cursor from previous response
  - extra_info (boolean): Include comments, deprecation status, hidden flag, and limits (default: false)

Returns:
  { keys: [{ id, key, value, ... }], next?: string }
  Use the "next" value to fetch the next page.

Examples:
  - Use when: "Show me the translation keys in this file"
  - Use when: Browsing translations with pagination`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        file_id: z.string().describe("File ID from localazy_list_files"),
        lang: localazyLocaleSchema
          .default("en")
          .describe("Valid Localazy language code (default: en)"),
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
          .describe("Pagination cursor from previous response"),
        extra_info: z
          .boolean()
          .default(false)
          .describe("Include comments, deprecation, limits"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, file_id, lang, limit, next, extra_info }) => {
      try {
        const api = getClient();
        const result = await api.files.listKeysPage({
          project: project_id,
          file: file_id,
          lang: asLocale(lang),
          limit,
          next,
          extra_info,
        });

        const output = formatListKeysPageOutput(result, extra_info);

        return jsonResponse(output, "Use a smaller 'limit' or pagination with the 'next' cursor.");
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );

  server.registerTool(
    "localazy_search_keys",
    {
      title: "Search Translation Keys",
      description: `Search for translation keys matching a query across all files in a Localazy project. Searches both key names and values (case-insensitive).

Note: Localazy has no native search API, so this paginates through all keys in all files and filters client-side. May be slow for projects with many keys.

Args:
  - project_id (string): Project ID
  - query (string): Search term to match against key names or values (max 500 chars)
  - lang (string): Language code (default: "en")

Returns:
  Array of matching keys (max 1000 results) with: key path, value, file name.

Examples:
  - Use when: "Find all keys containing 'password'"
  - Use when: "Search for translations mentioning 'welcome'"`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Search term to match against key names or values"),
        lang: localazyLocaleSchema
          .default("en")
          .describe("Valid Localazy language code (default: en)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, query, lang }) => {
      try {
        const api = getClient();
        const matches: Array<{ key: string; value: unknown; file: string }> = [];
        const lowerQuery = query.toLowerCase();
        const MAX_RESULTS = parseInt(process.env.LOCALAZY_SEARCH_MAX_RESULTS ?? "1000", 10);
        // 1 page = 1000 keys. LOCALAZY_SEARCH_MAX_PAGES=0 for no cap.
        const MAX_PAGES = parseInt(process.env.LOCALAZY_SEARCH_MAX_PAGES ?? "10", 10) || Infinity;
        let totalPages = 0;

        const files = await api.files.list({ project: project_id });

        for (const file of files) {
          if (matches.length >= MAX_RESULTS || totalPages >= MAX_PAGES) break;

          let nextCursor: string | undefined;

          do {
            const result = await api.files.listKeysPage({
              project: project_id,
              file: file.id,
              lang: asLocale(lang),
              limit: 1000,
              next: nextCursor,
            });

            for (const k of result.keys) {
              if (matches.length >= MAX_RESULTS) break;

              const keyPath = formatKeyPath(k);
              const valueStr =
                typeof k.value === "string"
                  ? k.value
                  : JSON.stringify(k.value);

              if (
                keyPath.toLowerCase().includes(lowerQuery) ||
                valueStr.toLowerCase().includes(lowerQuery)
              ) {
                matches.push({ key: keyPath, value: k.value, file: file.name });
              }
            }

            nextCursor = result.next;
            totalPages++;
          } while (nextCursor && matches.length < MAX_RESULTS && totalPages < MAX_PAGES);
        }

        if (matches.length === 0) {
          return jsonResponse({
            query,
            lang,
            count: 0,
            keys: [],
            message: `No keys found matching '${query}' in language '${lang}'.`,
          });
        }

        return jsonResponse({
          query,
          lang,
          count: matches.length,
          truncated: matches.length >= MAX_RESULTS,
          keys: matches,
        });
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
