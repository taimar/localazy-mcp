import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { invalidateCache } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { isOutcomeUnknown, withWriteRetry } from "../lib/retry.js";
import { resolveProject } from "../lib/translations.js";

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

function isTranslationObject(value: TranslationValue): value is TranslationFile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeTranslationObjects(target: TranslationFile, incoming: TranslationFile, path: string): void {
  for (const [key, value] of Object.entries(incoming)) {
    const existing = target[key];
    const nextPath = `${path}.${key}`;

    if (existing === undefined) {
      target[key] = value;
      continue;
    }

    if (isTranslationObject(existing) && isTranslationObject(value)) {
      mergeTranslationObjects(existing, value, nextPath);
      continue;
    }

    throw new Error(`Conflicting translation structure at '${nextPath}'.`);
  }
}

function normalizeTranslationFile(file: TranslationFile): TranslationFile {
  const normalized: TranslationFile = {};
  for (const [rawKey, rawValue] of Object.entries(file)) {
    const parts = rawKey.split(".");
    const normalizedValue = isTranslationObject(rawValue)
      ? normalizeTranslationFile(rawValue)
      : rawValue;
    let cursor = normalized;

    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];

      if (existing === undefined) {
        const next: TranslationFile = {};
        cursor[part] = next;
        cursor = next;
        continue;
      }

      if (!isTranslationObject(existing)) {
        throw new Error(`Conflicting translation structure at '${rawKey}'.`);
      }

      cursor = existing;
    }

    const leafKey = parts[parts.length - 1]!;
    const existing = cursor[leafKey];

    if (existing === undefined) {
      cursor[leafKey] = normalizedValue;
      continue;
    }

    if (isTranslationObject(existing) && isTranslationObject(normalizedValue)) {
      mergeTranslationObjects(existing, normalizedValue, rawKey);
      continue;
    }

    throw new Error(`Conflicting translation structure at '${rawKey}'.`);
  }

  return normalized;
}

export function normalizeTranslationsForImport(
  translations: Record<string, TranslationFile>
): Record<string, TranslationFile> {
  return Object.fromEntries(
    Object.entries(translations).map(([lang, file]) => [lang, normalizeTranslationFile(file)])
  );
}

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_upload_translations",
    {
      title: "Upload Translations",
      description: `Create or update translation keys in a Localazy project. Returns the file ID and import batch ID.

Cannot delete keys — that requires the Localazy web UI.`,
      inputSchema: z.object({
        translations: translationsSchema.describe(
          'Translation data as { lang: { key: value } }. Keys may be flat dot-notation or nested; values may be strings, string arrays, or plural maps like { "one": "1 item", "other": "%d items" }. Example: { "en": { "common.greeting": "Hello" }, "de": { "common": { "greeting": "Hallo" } } }'
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
          .describe("Set uploaded translations as current version"),
        force_source: z
          .boolean()
          .default(false)
          .describe("Overwrite source language content even if edited"),
        import_as_new: z
          .boolean()
          .default(false)
          .describe("All uploaded translations go through review"),
      }),
      // Destructive because an upload overwrites the previous value of any key
      // it names, and `force_source` overwrites source content that a human has
      // already edited. Not idempotent because every call creates a new import
      // batch and spends one of the project's 100 imports per day, which is why
      // this is the one call that uses `withWriteRetry`: a 5xx or a dropped
      // connection cannot say whether Localazy accepted the import, so retrying
      // it is not safe.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      translations,
      file_name,
      file_path,
      force_current,
      force_source,
      import_as_new,
    }) => {
      try {
        const api = getClient();
        const project = await resolveProject();
        const normalizedTranslations = normalizeTranslationsForImport(translations);
        try {
          const result = await withWriteRetry(() => api.import.json({
            project: project.id,
            json: normalizedTranslations,
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
          // "socket hang up" reads as "nothing happened", and an agent that
          // believes it sends the import again. Only an uncertain failure is
          // warned about, so a rejected one is not made to look doubtful.
          const message = handleError(error);
          return errorResponse(
            isOutcomeUnknown(error)
              ? `${message} This error does not show whether Localazy applied the upload. Check the file in Localazy before you send it again.`
              : message
          );
        } finally {
          // Also on failure: a write that reported an error may still have
          // landed, so whatever was cached before it is suspect either way.
          invalidateCache();
        }
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
