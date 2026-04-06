import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";

type TranslationValue = string | string[] | { [key: string]: TranslationValue };
type TranslationFile = Record<string, TranslationValue>;

// Translation values can be plain strings, string arrays, or nested objects,
// which covers both structured keys and plural maps.
const translationValueSchema: z.ZodType<TranslationValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(z.string()),
    z.record(z.string(), translationValueSchema),
  ])
);

export const translationsSchema: z.ZodType<Record<string, TranslationFile>> = z
  .record(z.string(), z.record(z.string(), translationValueSchema))
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one language must be provided",
  });

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_import_translations",
    {
      title: "Import Translations",
      description: `Import/upload translations to a Localazy project.

Accepts a JSON object mapping language codes to key-value translation pairs. Creates or updates translation keys in the specified project.

Args:
  - project_id (string): Project ID
  - translations (object): Translation data as { lang: { key: value } }
    Values can be strings, string arrays, or nested objects like
    { "common": { "greeting": "Hello" }, "items": ["One", "Two"] }
    Plural objects like { "one": "1 item", "other": "%d items" } are also supported
    Example: { "en": { "common": { "greeting": "Hello" } }, "de": { "common": { "greeting": "Hallo" } } }
  - file_name (string): Target file name in Localazy (default: "import.json")
  - file_path (string): File path in Localazy (optional)
  - force_current (boolean): Set imported translations as current version (default: false)
  - force_source (boolean): Overwrite source language content even if edited (default: false)
  - import_as_new (boolean): All translations go through review (default: false)

Returns:
  Import result with file ID and import batch ID.

Examples:
  - Use when: "Upload these translations to Localazy"
  - Use when: "Add German translations for the greeting key"
  - Don't use when: You need to delete keys (use Localazy web UI)`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        translations: translationsSchema.describe(
          'Translation data: { lang: { key: value } }. Supports nested objects and string arrays, for example { "en": { "common": { "greeting": "Hello" } } }'
        ),
        file_name: z
          .string()
          .default("import.json")
          .describe("Target file name in Localazy"),
        file_path: z
          .string()
          .optional()
          .describe("File path in Localazy (optional)"),
        force_current: z
          .boolean()
          .default(false)
          .describe("Set imported translations as current version"),
        force_source: z
          .boolean()
          .default(false)
          .describe("Overwrite source language content even if edited"),
        import_as_new: z
          .boolean()
          .default(false)
          .describe("All translations go through review"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      project_id,
      translations,
      file_name,
      file_path,
      force_current,
      force_source,
      import_as_new,
    }) => {
      try {
        const api = getClient();
        const result = await withRetry(() => api.import.json({
          project: project_id,
          json: translations,
          fileOptions: {
            name: file_name,
            ...(file_path ? { path: file_path } : {}),
          },
          i18nOptions: {
            forceCurrent: force_current,
            forceSource: force_source,
            importAsNew: import_as_new,
          },
        }));

        return jsonResponse(result);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
