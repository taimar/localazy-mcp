import type { File, Key, Project } from "@localazy/api-client";
import { cacheKeys, cached } from "./cache.js";
import { getClient } from "./client.js";
import { withRetry } from "./retry.js";
import { asLocale } from "../types.js";

export type FlatTranslation = {
  key: string;
  text: string;
};

export function formatKeyPath(key: Key): string {
  return key.key.join(".");
}

/**
 * Readable path for a file, for the `files` lookup table that responses use
 * instead of repeating the label on every item.
 */
export function buildFileLabels(files: File[], usedIds: Set<string>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const file of files) {
    if (usedIds.has(file.id)) labels[file.id] = formatFileLabel(file);
  }
  return labels;
}

function formatFileLabel(file: File): string {
  if (!file.path) return file.name;
  const trimmedPath = file.path.replace(/\/+$/, "");
  return trimmedPath ? `${trimmedPath}/${file.name}` : file.name;
}

export function flattenTranslations(keys: Key[]): FlatTranslation[] {
  const entries: FlatTranslation[] = [];

  function visit(keyPath: string, value: unknown): void {
    if (typeof value === "string") {
      entries.push({ key: keyPath, text: value });
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${keyPath}[${index}]`, item));
      return;
    }

    if (value && typeof value === "object") {
      for (const [part, item] of Object.entries(value as Record<string, unknown>)) {
        visit(`${keyPath}.${part}`, item);
      }
    }
  }

  for (const key of keys) {
    visit(formatKeyPath(key), key.value);
  }

  return entries;
}

/**
 * The project every tool operates on, fetched once per session.
 *
 * Fractory has a single Localazy project, so no tool takes a project ID —
 * they all resolve it here. `languages: true` comes along for free and gives
 * us the source language without a second request.
 */
export async function resolveProject(): Promise<Project> {
  const projects = await cached(cacheKeys.projects, () =>
    withRetry(() => getClient().projects.list({ languages: true }))
  ) as Project[];

  const project = projects[0];
  if (!project) {
    throw new Error(
      "No Localazy project is accessible with the configured LOCALAZY_API_TOKEN."
    );
  }
  return project;
}

export function getSourceLang(project: Project): string {
  return project.languages.find((language) => language.id === project.sourceLanguage)?.code ?? "en";
}

/**
 * Why this exists: Localazy answers a request for a language the project does
 * not have with an empty key list and no error. Without this check, auditing an
 * unconfigured language spends a request per file and then reports zero issues
 * over zero values — indistinguishable from a clean result.
 *
 * Throws rather than returning a message, so no caller can read the language and
 * forget to act on the answer. Every tool renders a thrown error through
 * `handleError`, which prefixes it the same way an `errorResponse` would.
 */
export function assertProjectLanguage(project: Project, lang: string): void {
  if (project.languages.some((language) => language.code === lang)) return;

  const available = project.languages.map((language) => language.code).sort().join(", ");
  throw new Error(
    `'${lang}' is not a language in this project. Available languages: ${available}.`
  );
}

async function resolveFiles(projectId: string): Promise<File[]> {
  return cached(cacheKeys.files(projectId), () =>
    withRetry(() => getClient().files.list({ project: projectId }))
  ) as Promise<File[]>;
}

/** The project plus its file list — the starting point for every project-wide scan. */
export async function resolveProjectFiles(): Promise<{ project: Project; files: File[] }> {
  const project = await resolveProject();
  const files = await resolveFiles(project.id);
  return { project, files };
}

/**
 * All translation values in a file, flattened to `key` / `text` pairs.
 *
 * Caches the flattened form rather than the raw key tree, so repeat reads skip
 * the tree walk. That matters because a cross-language audit reads the source
 * language once per file and then hits this cache for every other language.
 */
export async function listFlatTranslations(
  projectId: string,
  fileId: string,
  lang: string,
): Promise<FlatTranslation[]> {
  return cached(cacheKeys.flat(projectId, fileId, lang), async () => {
    const keys = await withRetry(() =>
      getClient().files.listKeys({
        project: projectId,
        file: fileId,
        lang: asLocale(lang),
      })
    );
    return flattenTranslations(keys);
  });
}

/**
 * One raw page of keys from a file, for manual browsing.
 *
 * Lives beside the other Localazy reads so no tool assembles client, retry and
 * cache wiring of its own — the page cursor is the only thing the caller tracks.
 */
export async function listKeysPage(options: {
  projectId: string;
  fileId: string;
  lang: string;
  limit: number;
  extraInfo: boolean;
  cursor?: string;
}) {
  const { projectId, fileId, lang, limit, extraInfo, cursor } = options;

  return cached(cacheKeys.keysPage(projectId, fileId, lang, limit, extraInfo, cursor), () =>
    withRetry(() => getClient().files.listKeysPage({
      project: projectId,
      file: fileId,
      lang: asLocale(lang),
      limit,
      next: cursor,
      extra_info: extraInfo,
    }))
  );
}
