import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";
import { asLocale, localazyLocaleSchema } from "../types.js";
import type { Key } from "../types.js";

function formatKeyPath(key: Key): string {
  return key.key.join(".");
}

function keysPageCacheKey(
  projectId: string, fileId: string, lang: string,
  limit: number, extraInfo: boolean, cursor?: string,
): string {
  return `keys:${projectId}:${fileId}:${lang}:${limit}:${extraInfo}:${cursor ?? "first"}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length && !shouldStop()) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

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
      description: `List translation keys from a specific file in a Localazy project, with pagination.

Args:
  - project_id (string): Project ID
  - file_id (string): File ID from localazy_list_files
  - lang (string): Language code (default: "en")
  - limit (number): Max keys per page, 1-1000 (default: 100)
  - next (string): Pagination cursor from previous response
  - prefix (string): Filter keys matching a dot-path prefix (e.g. "detailViewer" returns the exact key and all detailViewer.* children). Applied client-side after fetching.
  - extra_info (boolean): Include comments, deprecation status, hidden flag, and limits (default: false)

Returns:
  { count, keys: [{ id, key, value, ... }], next?: string }
  Use the "next" value to fetch the next page.

Examples:
  - Use when: "Show me the translation keys in this file"
  - Use when: Browsing translations with pagination
  - Use when: "Show me only the detailViewer keys" (use prefix parameter)`,
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
        prefix: z
          .string()
          .optional()
          .describe("Filter keys matching a dot-path prefix (e.g. 'detailViewer' returns the exact key and all detailViewer.* children)"),
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
    async ({ project_id, file_id, lang, limit, next, prefix, extra_info }) => {
      try {
        const api = getClient();
        const hint = "Use a smaller 'limit', pagination with the 'next' cursor, or a 'prefix' filter.";

        const fetchPage = async (pageLimit: number) => {
          const cacheKey = keysPageCacheKey(project_id, file_id, lang, pageLimit, extra_info, next);
          const result = await cached(cacheKey, () =>
            withRetry(() => api.files.listKeysPage({
              project: project_id, file: file_id, lang: asLocale(lang),
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
  - file_ids (string[]): Optional: limit search to specific file IDs (from localazy_list_files). Searches all files if omitted.

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
        file_ids: z
          .array(z.string())
          .optional()
          .describe("Optional: limit search to specific file IDs (from localazy_list_files). Searches all files if omitted."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, query, lang, file_ids }) => {
      try {
        const api = getClient();
        const lowerQuery = query.toLowerCase();
        const MAX_RESULTS = parseInt(process.env.LOCALAZY_SEARCH_MAX_RESULTS ?? "1000", 10);
        // 1 page = 1000 keys. LOCALAZY_SEARCH_MAX_PAGES=0 for no cap.
        const MAX_PAGES = parseInt(process.env.LOCALAZY_SEARCH_MAX_PAGES ?? "10", 10) || Infinity;
        const CONCURRENCY = Math.max(1, parseInt(process.env.LOCALAZY_SEARCH_CONCURRENCY ?? "3", 10));

        const state = { matchesFound: 0 };

        const allFiles = await cached(`files:${project_id}`, () =>
          withRetry(() => api.files.list({ project: project_id }))
        );

        // Optionally narrow to specific files
        let files = allFiles;
        if (file_ids?.length) {
          const idSet = new Set(file_ids);
          files = allFiles.filter((f: { id: string }) => idSet.has(f.id));
        }

        const fileResults = await mapWithConcurrency(
          files,
          CONCURRENCY,
          async (file) => {
            const fileMatches: Array<{ key: string; value: unknown; file: string }> = [];
            let nextCursor: string | undefined;
            let filePages = 0;

            do {
              if (MAX_PAGES !== Infinity && filePages >= MAX_PAGES) break;
              if (state.matchesFound >= MAX_RESULTS) break;
              filePages++;

              const cacheKey = keysPageCacheKey(project_id, file.id, lang, 1000, false, nextCursor);
              const result = await cached(cacheKey, () =>
                withRetry(() =>
                  api.files.listKeysPage({
                    project: project_id,
                    file: file.id,
                    lang: asLocale(lang),
                    limit: 1000,
                    next: nextCursor,
                  })
                )
              );

              for (const k of result.keys) {
                if (state.matchesFound >= MAX_RESULTS) break;

                const keyPath = formatKeyPath(k);
                const valueStr =
                  typeof k.value === "string"
                    ? k.value
                    : JSON.stringify(k.value);

                if (
                  keyPath.toLowerCase().includes(lowerQuery) ||
                  valueStr.toLowerCase().includes(lowerQuery)
                ) {
                  const displayValue =
                    typeof k.value === "string" && k.value.length > 500
                      ? k.value.slice(0, 500) + "..."
                      : k.value;
                  fileMatches.push({ key: keyPath, value: displayValue, file: file.name });
                  state.matchesFound++;
                }
              }

              nextCursor = result.next;
            } while (nextCursor);

            return fileMatches;
          },
          () => state.matchesFound >= MAX_RESULTS,
        );

        const allMatches = fileResults.flat();
        const matches = allMatches.slice(0, MAX_RESULTS);
        const truncated = allMatches.length > MAX_RESULTS;

        if (matches.length === 0) {
          return jsonResponseArray(
            [],
            "keys",
            { query, lang, count: 0, message: `No keys found matching '${query}' in language '${lang}'.` },
          );
        }

        return jsonResponseArray(
          matches,
          "keys",
          { query, lang, count: matches.length, ...(truncated ? { truncated } : {}) },
        );
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
