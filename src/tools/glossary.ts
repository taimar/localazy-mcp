import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../lib/client.js";
import { handleError } from "../lib/errors.js";
import { jsonResponse, errorResponse } from "../lib/response.js";
import { asLocale, localazyLocaleSchema } from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "localazy_list_glossary",
    {
      title: "List Glossary Terms",
      description: `List all glossary terms for a Localazy project.

Args:
  - project_id (string): Project ID

Returns:
  Array of glossary records with: id, description, translateTerm, caseSensitive, and terms in each language.

Examples:
  - Use when: "Show all glossary terms for this project"
  - Use when: Checking if a term is already in the glossary`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
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
        const terms = await api.glossary.list({ project: project_id });
        return jsonResponse(terms);
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );

  server.registerTool(
    "localazy_create_glossary_term",
    {
      title: "Create Glossary Term",
      description: `Create a new glossary term in a Localazy project.

Args:
  - project_id (string): Project ID
  - terms (array): Term in each language. Must include the source language.
    Example: [{ "lang": "en", "term": "Dashboard" }, { "lang": "de", "term": "Dashboard" }]
  - description (string): Optional description of the term
  - translate_term (boolean): Whether the term should be translated (default: true)
  - case_sensitive (boolean): Case-sensitive matching (default: false)

Returns:
  The created glossary term ID.

Examples:
  - Use when: "Add 'Dashboard' to the glossary"
  - Use when: "Create a glossary entry for technical terms"`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        terms: z
          .array(
            z.object({
              lang: localazyLocaleSchema.describe("Valid Localazy language code"),
              term: z.string().describe("Term text"),
            })
          )
          .min(1)
          .describe("Term in each language (must include source language)"),
        description: z
          .string()
          .optional()
          .describe("Description of the glossary term"),
        translate_term: z
          .boolean()
          .default(true)
          .describe("Whether the term should be translated"),
        case_sensitive: z
          .boolean()
          .default(false)
          .describe("Case-sensitive matching"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      project_id,
      terms,
      description,
      translate_term,
      case_sensitive,
    }) => {
      try {
        const api = getClient();
        const id = await api.glossary.create({
          project: project_id,
          description: description ?? "",
          translateTerm: translate_term,
          caseSensitive: case_sensitive,
          term: terms.map((t) => ({ ...t, lang: asLocale(t.lang) })),
        });

        return jsonResponse({ success: true, glossary_term_id: id });
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );

  server.registerTool(
    "localazy_delete_glossary_term",
    {
      title: "Delete Glossary Term",
      description: `Delete a glossary term from a Localazy project.

Args:
  - project_id (string): Project ID
  - glossary_term_id (string): Glossary term ID from localazy_list_glossary

Returns:
  Success confirmation.

Examples:
  - Use when: "Remove this glossary term"`,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        glossary_term_id: z
          .string()
          .describe("Glossary term ID from localazy_list_glossary"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, glossary_term_id }) => {
      try {
        const api = getClient();
        await api.glossary.delete({
          project: project_id,
          glossaryRecord: glossary_term_id,
        });

        return jsonResponse({ success: true, deleted: glossary_term_id });
      } catch (error) {
        return errorResponse(handleError(error));
      }
    }
  );
}
