import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";

type ProjectWithLanguages = { id: string; languages?: unknown[] };

/**
 * Try two strategies for fetching project languages:
 * 1. SDK method: api.projects.list({ languages: true })
 * 2. Direct GET: /projects?languages=true  (bypasses SDK parameter handling)
 *
 * Some token types / API-client versions hit 404 with the SDK path,
 * so we fall back to the raw request.
 */
async function fetchProjectLanguages(): Promise<unknown[] | null> {
  const api = getClient();

  try {
    const project = await withRetry(() =>
      api.projects.first({ languages: true })
    ) as ProjectWithLanguages;
    if (project?.languages) return project.languages;
  } catch {
    // endpoint failed
  }

  return null;
}

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
        const languages = await cached(`languages:${project_id}`, () =>
          fetchProjectLanguages()
        ) as unknown[] | null;

        if (!languages) {
          return errorResponse(
            `Error: Could not retrieve languages for project '${project_id}'. ` +
            `Check your LOCALAZY_API_TOKEN permissions and that the project ID is correct. ` +
            `Use localazy_list_projects to get valid IDs.`
          );
        }

        return jsonResponse(languages);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
