#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register as registerFiles } from "./tools/files.js";
import { register as registerLanguages } from "./tools/languages.js";
import { register as registerKeys } from "./tools/keys.js";
import { register as registerImport } from "./tools/import.js";
import { register as registerFind } from "./tools/find.js";
import { register as registerQuality } from "./tools/quality.js";

const server = new McpServer(
  { name: "localazy-mcp-server", version: "1.0.0" },
  {
    instructions: `Localazy translation management for Fractory's single Localazy project. Use for translation keys, localized strings, languages, and localization files. No tool takes a project ID — the project is resolved from the API token.

- localazy_find_translations — search key names and values ("invoice-related keys in ET", "checkout strings in Estonian").
- localazy_audit_translations — QA sweeps; set scope to 'style' (punctuation, quotes, dashes, spacing), 'syntax' (placeholders, tags), or 'all'.
- localazy_list_languages / localazy_list_files — what exists, and file IDs.
- localazy_list_keys — manual paginated browsing of one file.
- localazy_upload_translations — create or update keys.

Always display translation values in full — never shorten, truncate, or elide them.`,
  },
);

registerFiles(server);
registerLanguages(server);
registerKeys(server);
registerFind(server);
registerQuality(server);
registerImport(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Localazy MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
