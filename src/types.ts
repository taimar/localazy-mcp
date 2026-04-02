import { z } from "zod";
import { Locales } from "@localazy/languages";

export type { Key } from "@localazy/api-client";

/**
 * The Localazy API expects `${Locales}` template literal types.
 * Since MCP tool inputs are plain strings, we cast them through this type.
 */
export type LocalazyLocale = `${Locales}`;

const LOCALAZY_LOCALE_SET = new Set<LocalazyLocale>(
  Object.values(Locales) as LocalazyLocale[]
);

const INVALID_LOCALE_MESSAGE =
  "Use a valid Localazy locale code such as 'en', 'et', 'fi', 'fr', 'it', or 'sv'.";

export const localazyLocaleSchema = z
  .string()
  .refine((lang): lang is LocalazyLocale => LOCALAZY_LOCALE_SET.has(lang as LocalazyLocale), {
    message: INVALID_LOCALE_MESSAGE,
  });

export const localazyLocalesSchema = z.array(localazyLocaleSchema);

export function asLocale(lang: string): LocalazyLocale {
  return lang as LocalazyLocale;
}

export function asLocales(langs: string[]): LocalazyLocale[] {
  return langs as LocalazyLocale[];
}
