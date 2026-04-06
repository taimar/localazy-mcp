import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_languages",
    {
      title: "List Project Languages",
      description: `List all languages configured for a Localazy project with translation statistics.

Args:
  - project_id (string): Project ID from localazy_list_projects

Returns:
  Array of languages with: language code, name, active keys count, translated/reviewed counts.

Examples:
  - Use when: "What languages are configured for this project?"
  - Use when: You need language codes for translation operations`,
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
        const project = await api.client.get(`/projects/${project_id}`, {
          params: { languages: "true" },
        }) as { languages?: unknown[] };

        if (!project || !project.languages) {
          return errorResponse(
            `Error: Project '${project_id}' not found or has no languages. Use localazy_list_projects to get valid IDs.`
          );
        }

        return jsonResponse(project.languages);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
