#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register as registerProjects } from "./tools/projects.js";
import { register as registerFiles } from "./tools/files.js";
import { register as registerLanguages } from "./tools/languages.js";
import { register as registerKeys } from "./tools/keys.js";
import { register as registerImport } from "./tools/import.js";

const server = new McpServer(
  { name: "localazy-mcp-server", version: "1.0.0" },
  {
    instructions: `Localazy translation management server. Use these tools when the user asks about translation keys, localized strings, languages, or localization files. Users may say "Localazy" to explicitly target this server. When showing Localazy translation results, always display every value in full. Never shorten, truncate, or use ellipsis for translation values.`,
  },
);

registerProjects(server);
registerFiles(server);
registerLanguages(server);
registerKeys(server);
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
