import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILE_CONCURRENCY } from "../constants.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { handleError } from "../lib/errors.js";
import { jsonResponseArray, errorResponse } from "../lib/response.js";
import {
  buildFileLabels,
  checkProjectLanguage,
  listFlatTranslations,
  resolveProjectFiles,
} from "../lib/translations.js";
import { localazyLocaleSchema } from "../types.js";

type MatchedField = "key" | "target_value";

/**
 * Upper bound on matches collected. The response character budget usually
 * trims further; this only stops a broad query from buffering the whole
 * project in memory.
 */
const MAX_MATCHES = 500;

/**
 * Which sides a lowercased query matches, or null for no match.
 *
 * Takes the query pre-lowercased and returns null rather than an empty array,
 * because this runs once per translation value in the project.
 */
export function matchFields(
  lowerQuery: string,
  key: string,
  targetValue: string,
): MatchedField[] | null {
  const inKey = key.toLowerCase().includes(lowerQuery);
  const inValue = targetValue.toLowerCase().includes(lowerQuery);

  if (inKey && inValue) return ["key", "target_value"];
  if (inKey) return ["key"];
  if (inValue) return ["target_value"];
  return null;
}

type FileMatch = {
  fileId: string;
  key: string;
  targetValue: string;
  matchedIn: MatchedField[];
};

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_find_translations",
    {
      title: "Find Translations",
      description: `Search key names and target values (case-insensitive, substring) across every translation file.

Use for "Find invoice-related keys in ET", "Show checkout strings in Estonian", "Which keys mention 'password'".

Each match reports which side matched in \`matched_in\`; resolve \`file_id\` via the \`files\` map. Nested keys, plural forms, and string arrays are flattened, so keys look like \`common.count.other[1]\`.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Search text to match against key names and target values"),
        lang: localazyLocaleSchema
          .default("en")
          .describe("Language code to search, for example 'et'"),
        file_ids: z
          .array(z.string())
          .optional()
          .describe("Limit the search to these file IDs (from localazy_list_files); searches all files if omitted"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, lang, file_ids }) => {
      try {
        const lowerQuery = query.trim().toLowerCase();
        if (!lowerQuery) {
          return errorResponse("Error: query must contain at least one non-whitespace character.");
        }

        const { project, files: allFiles } = await resolveProjectFiles();

        const languageError = checkProjectLanguage(project, lang);
        if (languageError) return errorResponse(languageError);

        let files = allFiles;
        if (file_ids?.length) {
          const idSet = new Set(file_ids);
          files = allFiles.filter((file) => idSet.has(file.id));
          if (files.length === 0) {
            return errorResponse(
              "Error: none of the given file_ids exist in this project. Use localazy_list_files to get valid IDs."
            );
          }
        }

        // Files are scanned in parallel; `found` lets in-flight workers stop
        // claiming new files once enough matches exist.
        let found = 0;
        const perFile = await mapWithConcurrency(
          files,
          FILE_CONCURRENCY,
          async (file): Promise<FileMatch[]> => {
            const entries = await listFlatTranslations(project.id, file.id, lang);
            const matches: FileMatch[] = [];

            for (const entry of entries) {
              const matchedIn = matchFields(lowerQuery, entry.key, entry.text);
              if (!matchedIn) continue;

              matches.push({
                fileId: file.id,
                key: entry.key,
                targetValue: entry.text,
                matchedIn,
              });

              if (matches.length >= MAX_MATCHES) break;
            }

            found += matches.length;
            return matches;
          },
          () => found >= MAX_MATCHES,
        );

        // `perFile` covers only the files that were scanned before the cap hit.
        const scanned = perFile.flat();
        const matches = scanned.slice(0, MAX_MATCHES);

        return jsonResponseArray(
          matches.map((match) => ({
            file_id: match.fileId,
            key: match.key,
            target_value: match.targetValue,
            matched_in: match.matchedIn,
          })),
          "matches",
          {
            project_name: project.name,
            query,
            lang,
            file_count: files.length,
            match_count: matches.length,
            limited: scanned.length > matches.length || perFile.length < files.length,
            files: buildFileLabels(files, new Set(matches.map((match) => match.fileId))),
          },
          `Response contains the first ${MAX_MATCHES} matches. Refine the query if you need a smaller result set.`
        );
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
