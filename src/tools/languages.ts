import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse, READ_ONLY_ANNOTATIONS } from "../lib/response.js";
import { resolveProject } from "../lib/translations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_languages",
    {
      title: "List Project Languages",
      description: `List the project's languages with translation statistics: { code, name, source?, active, translated, current, review, sourceChanged, needImprovement }.

\`active\` is the total key count and \`current\` is the approved count, so \`translated\` may exceed it. Use when the user asks which languages exist or how complete a translation is.`,
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const project = await resolveProject();
        return jsonResponse({
          project_name: project.name,
          languages: project.languages.map((language) => ({
            code: language.code,
            name: language.name,
            ...(language.id === project.sourceLanguage ? { source: true } : {}),
            active: language.active,
            translated: language.translated,
            current: language.current,
            review: language.review,
            sourceChanged: language.sourceChanged,
            needImprovement: language.needImprovement,
          })),
        });
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
