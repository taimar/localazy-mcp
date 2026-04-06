import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_files",
    {
      title: "List Project Files",
      description: `List all translation files in a Localazy project.

Returns file details including ID, name, type, and path. Use file IDs from the results with localazy_list_keys, localazy_export_translations, etc.

Args:
  - project_id (string): Project ID from localazy_list_projects

Returns:
  Array of files with: id, name, type, path, module.

Examples:
  - Use when: "What translation files are in this project?"
  - Use when: You need a file ID for key/translation operations`,
      inputSchema: {
        project_id: z
          .string()
          .describe("Project ID from localazy_list_projects"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id }) => {
      try {
        const api = getClient();
        const files = await cached(`files:${project_id}`, () =>
          withRetry(() => api.files.list({ project: project_id }))
        );
        return jsonResponse(files);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
