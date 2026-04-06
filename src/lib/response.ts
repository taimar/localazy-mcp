import { CHARACTER_LIMIT } from "../constants.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function truncateText(text: string, truncationHint?: string): string {
  if (text.length <= CHARACTER_LIMIT) {
    return text;
  }

  const hint = truncationHint ?? "Use pagination or filters to reduce results.";
  const suffix =
    `\n\n... [TRUNCATED] Response exceeded ${CHARACTER_LIMIT} characters. ${hint}`;
  const sliceLength = Math.max(0, CHARACTER_LIMIT - suffix.length);
  return text.slice(0, sliceLength) + suffix;
}

/**
 * Create a successful tool response from a JSON-serializable value.
 * Truncates if the serialized output exceeds CHARACTER_LIMIT.
 */
export function jsonResponse(data: unknown, truncationHint?: string): ToolResult {
  const text = truncateText(JSON.stringify(data), truncationHint);
  return { content: [{ type: "text", text }] };
}

/**
 * Create a successful tool response from raw text content.
 * Truncates if the text exceeds CHARACTER_LIMIT.
 */
export function textResponse(text: string, truncationHint?: string): ToolResult {
  return { content: [{ type: "text", text: truncateText(text, truncationHint) }] };
}

/**
 * Create an error tool response.
 */
export function errorResponse(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
