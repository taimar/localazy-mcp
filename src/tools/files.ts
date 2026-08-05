import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { resolveProjectFiles } from "../lib/translations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_files",
    {
      title: "List Project Files",
      description: `List the translation files, as { id, name, type, path?, module? }.

Use when you need a file ID for localazy_list_keys or to narrow localazy_find_translations.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const { files } = await resolveProjectFiles();
        return jsonResponse(
          files.map((file) => ({
            id: file.id,
            name: file.name,
            type: file.type,
            ...(file.path ? { path: file.path } : {}),
            ...(file.module ? { module: file.module } : {}),
          }))
        );
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
