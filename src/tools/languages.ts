import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cached } from "../lib/cache.js";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { withRetry } from "../lib/retry.js";

type ProjectWithLanguages = { id: string; languages?: unknown[] };

async function fetchProjectLanguages(projectId: string): Promise<unknown[]> {
  const api = getClient();
  const projects = await withRetry(() =>
    api.projects.list({ languages: true })
  ) as ProjectWithLanguages[];
  const project = projects.find((p) => p.id === projectId);
  if (!project?.languages) {
    throw new Error(`No languages found for project '${projectId}'`);
  }
  return project.languages;
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
          fetchProjectLanguages(project_id)
        );
        return jsonResponse(languages);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
