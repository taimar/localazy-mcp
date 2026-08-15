#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { register as registerFiles } from "./tools/files.js";
import { register as registerLanguages } from "./tools/languages.js";
import { register as registerKeys } from "./tools/keys.js";
import { register as registerImport } from "./tools/import.js";
import { register as registerFind } from "./tools/find.js";
import { register as registerQuality } from "./tools/quality.js";

const INSTRUCTIONS = `Localazy translation management for Fractory's single Localazy project. Use for translation keys, localized strings, languages, and localization files. No tool takes a project ID — the project is resolved from the API token.

- localazy_find_translations — search key names and values ("invoice-related keys in ET", "checkout strings in Estonian").
- localazy_audit_translations — QA sweeps; set scope to 'style' (punctuation, quotes, dashes, spacing), 'syntax' (placeholders, tags), or 'all'.
- localazy_list_languages / localazy_list_files — what exists, and file IDs.
- localazy_list_keys — manual paginated browsing of one file.
- localazy_upload_translations — create or update keys.

Always display translation values in full — never shorten, truncate, or elide them.`;

/**
 * Builds one fully registered server instance.
 *
 * `serveStdio` calls this once per connection, and once more for a
 * `server/discover` probe that it discards if the client turns out to be a
 * 2025-era one that falls back to `initialize`. So this has to stay cheap and
 * free of side effects: it only registers tools. Everything with real cost —
 * the caches, the rate limiter, the resolved project — lives at module scope
 * in `lib/`, so every instance shares one copy and a discarded probe costs
 * nothing.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "localazy-mcp-server", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  registerFiles(server);
  registerLanguages(server);
  registerKeys(server);
  registerFind(server);
  registerQuality(server);
  registerImport(server);

  return server;
}

// One factory serves both protocol eras. `legacy: 'serve'` is the default, so
// a 2025-era client that opens with `initialize` is served exactly as before,
// while a client pinned to 2026-07-28 opens with `server/discover` instead.
serveStdio(buildServer, {
  onerror: (error) => console.error("Server error:", error),
});

console.error("Localazy MCP server running via stdio");
