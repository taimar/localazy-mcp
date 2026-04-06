import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_projects",
    {
      title: "List Localazy Projects",
      description: `List all Localazy projects accessible with the configured API token.

Returns project details including ID, name, slug, and URL. Use the project ID from the results as input for other Localazy tools.

Returns:
  Array of projects with: id, name, slug, orgId, url, description, type, tone.

Examples:
  - Use when: "What Localazy projects do I have access to?"
  - Use when: You need a project ID to pass to other localazy_ tools`,
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
        const api = getClient();
        const projects = await cached("projects", () =>
          withRetry(() => api.projects.list())
        );
        return jsonResponse(projects);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
