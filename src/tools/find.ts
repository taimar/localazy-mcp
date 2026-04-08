import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse } from "../lib/response.js";
import {
  flattenTranslations,
  formatFileLabel,
  listAllKeys,
  resolveFiles,
  resolveProject,
} from "../lib/translations.js";
import { localazyLocaleSchema } from "../types.js";

type MatchedField = "key" | "target_value";

const MAX_MATCHES = 100;

export function findMatchedFields(
  query: string,
  key: string,
  targetValue: string,
): MatchedField[] {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return [];

  const matched: MatchedField[] = [];

  if (key.toLowerCase().includes(lowerQuery)) {
    matched.push("key");
  }

  if (targetValue.toLowerCase().includes(lowerQuery)) {
    matched.push("target_value");
  }

  return matched;
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_find_translations",
    {
      title: "Find Translations",
      description: `Find matching translations in one call.

Use this for requests like "Find invoice-related keys in ET" or "Show checkout strings in Estonian". It automatically uses the first accessible project, scans all files, and searches key names and target values.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Search text to match against key names and target values."),
        lang: localazyLocaleSchema
          .default("en")
          .describe("Valid Localazy language code to search, for example 'et'"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, lang }) => {
      try {
        const project = await resolveProject();
        const files = await resolveFiles(project.id);

        const matches: Array<{
          file: string;
          file_id: string;
          key: string;
          target_value: string;
          matched_in: MatchedField[];
        }> = [];
        let limited = false;

        for (const file of files) {
          if (matches.length >= MAX_MATCHES) {
            limited = true;
            break;
          }

          const targetKeys = await listAllKeys(project.id, file.id, lang);

          for (const entry of flattenTranslations(targetKeys)) {
            const matchedIn = findMatchedFields(query, entry.key, entry.text);

            if (matchedIn.length === 0) {
              continue;
            }

            if (matches.length >= MAX_MATCHES) {
              limited = true;
              break;
            }

            matches.push({
              file: formatFileLabel(file),
              file_id: file.id,
              key: entry.key,
              target_value: entry.text,
              matched_in: matchedIn,
            });
          }
        }

        return jsonResponseArray(
          matches,
          "matches",
          {
            project_id: project.id,
            project_name: project.name,
            query,
            lang,
            file_count: files.length,
            returned_count: matches.length,
            limited,
          },
          `Response contains the first ${MAX_MATCHES} matches. Refine the query if you need a smaller result set.`
        );
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
