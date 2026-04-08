import type { File, Key, Project } from "@localazy/api-client";
import { cached } from "./cache.js";
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

export function formatFileLabel(file: File): string {
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

export async function resolveProject(): Promise<Project> {
  return cached("project:first:withLanguages", () =>
    withRetry(() => getClient().projects.first({ languages: true }))
  ) as Promise<Project>;
}

export function getSourceLang(project: Project): string {
  return project.languages.find((language) => language.id === project.sourceLanguage)?.code ?? "en";
}

export async function resolveFiles(projectId: string): Promise<File[]> {
  return cached(`files:${projectId}`, () =>
    withRetry(() => getClient().files.list({ project: projectId }))
  ) as Promise<File[]>;
}

export async function listAllKeys(projectId: string, fileId: string, lang: string): Promise<Key[]> {
  return cached(`keys-all:${projectId}:${fileId}:${lang}`, () =>
    withRetry(() =>
      getClient().files.listKeys({
        project: projectId,
        file: fileId,
        lang: asLocale(lang),
      })
    )
  ) as Promise<Key[]>;
}
