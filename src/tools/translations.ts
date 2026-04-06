import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse, textResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";
import {
  asLocale,
  asLocales,
  localazyLocaleSchema,
  localazyLocalesSchema,
} from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_export_translations",
    {
      title: "Export Translations",
      description: `Export translations for one or more languages from a specific file as structured JSON.

Uses Localazy's export API to get translations organized by language. More efficient than listing keys per language.

Args:
  - project_id (string): Project ID
  - file_id (string): File ID from localazy_list_files
  - langs (string[]): Language codes to export (e.g. ["en", "de", "fr"])

Returns:
  JSON object mapping language codes to their translation key-value pairs.
  Example: { "en": { "greeting": "Hello" }, "de": { "greeting": "Hallo" } }

Examples:
  - Use when: "Get English and German translations for this file"
  - Use when: Comparing translations across languages`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        file_id: z.string().describe("File ID from localazy_list_files"),
        langs: localazyLocalesSchema
          .min(1)
          .describe(
            'Valid Localazy language codes to export (e.g. ["en", "de", "fr"])'
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, file_id, langs }) => {
      try {
        const api = getClient();
        const fullResult = await withRetry(() =>
          api.export.json({
            project: project_id,
            file: file_id,
            langs: asLocales(langs),
          })
        ) as Record<string, unknown>;

        // Build result language-by-language, tracking size incrementally
        // to avoid O(N * total_size) re-serialisation.
        const result: Record<string, unknown> = {};
        const includedLangs: string[] = [];
        const omittedLangs: string[] = [];
        let cumulativeSize = 2; // starts as '{}'

        for (const lang of langs) {
          if (!(lang in fullResult)) continue;
          const langJson = JSON.stringify(fullResult[lang]);
          // +5 = quotes around key, colon, comma, quotes: "lang":...
          const addedSize = lang.length + langJson.length + 4 + (includedLangs.length > 0 ? 1 : 0);
          if (cumulativeSize + addedSize > CHARACTER_LIMIT) {
            omittedLangs.push(lang);
            continue;
          }
          result[lang] = fullResult[lang];
          cumulativeSize += addedSize;
          includedLangs.push(lang);
        }

        if (includedLangs.length === 0) {
          return errorResponse(
            `Even a single language exceeds the ${CHARACTER_LIMIT} character limit for this file. ` +
            `Use localazy_download_file for individual language downloads, or set ` +
            `LOCALAZY_CHARACTER_LIMIT to a higher value.`
          );
        }

        if (omittedLangs.length > 0) {
          return jsonResponse({
            _warning: `Response too large for all languages. Included: [${includedLangs.join(", ")}]. Omitted: [${omittedLangs.join(", ")}]. Use localazy_download_file for individual languages.`,
            ...result,
          });
        }

        return jsonResponse(result);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );

  server.registerTool(
    "localazy_download_file",
    {
      title: "Download Translation File",
      description: `Download the raw translation file contents for a specific language.

Returns the file in its original format (e.g. JSON). Useful for getting the complete translation file as it would be downloaded from Localazy.

Args:
  - project_id (string): Project ID
  - file_id (string): File ID from localazy_list_files
  - lang (string): Language code (e.g. "en", "de")

Returns:
  Raw file contents as text.

Examples:
  - Use when: "Download the German translation file"
  - Use when: You need the complete file in its original format`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        file_id: z.string().describe("File ID from localazy_list_files"),
        lang: localazyLocaleSchema.describe(
          'Valid Localazy language code (e.g. "en", "de", "fr")'
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, file_id, lang }) => {
      try {
        const api = getClient();
        const blob = await withRetry(() => api.files.getContents({
          project: project_id,
          file: file_id,
          lang: asLocale(lang),
        }));
        const text = await blob.text();

        // Raw file contents — try to parse as JSON for pretty-printing
        try {
          const parsed = JSON.parse(text);
          return jsonResponse(parsed);
        } catch {
          return textResponse(
            text,
            "Try a smaller file or narrow the export to a single language."
          );
        }
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
