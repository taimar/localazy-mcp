import { CHARACTER_LIMIT } from "../constants.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Annotations every read-only tool registers. Clients treat these as hints about
 * what a tool may do, so all of the read tools have to state the same thing.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export type ArrayResponseMeta = {
  includedCount: number;
  totalCount: number;
  truncated: boolean;
};

export type ArrayResponse = ToolResult & { _arrayMeta: ArrayResponseMeta };

const DEFAULT_TRUNCATION_HINT = "Use pagination or filters to reduce results.";

function truncateText(text: string, hint = DEFAULT_TRUNCATION_HINT): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = `\n\n... [TRUNCATED] Response exceeded ${CHARACTER_LIMIT} characters. ${hint}`;
  return text.slice(0, Math.max(0, CHARACTER_LIMIT - suffix.length)) + suffix;
}

/**
 * How many leading items fit in `budget` once serialized.
 *
 * Serializes lazily and stops at the first item that does not fit, so a
 * 10,000-item result set that truncates at 200 pays for 201 serializations
 * rather than 10,000.
 */
function countItemsWithinBudget<T>(items: T[], budget: number): number {
  let used = 0;
  let count = 0;

  for (const item of items) {
    // JSON.stringify returns undefined for undefined; inside an array that
    // would serialize as "null".
    const fragment = JSON.stringify(item) ?? "null";
    const cost = fragment.length + (count > 0 ? 1 : 0);
    if (used + cost > budget) break;
    count++;
    used += cost;
  }

  return count;
}

/**
 * Serialize an array into a wrapper object, fitting as many complete items
 * as possible within CHARACTER_LIMIT. Always produces valid JSON.
 */
export function jsonResponseArray<T>(
  items: T[],
  itemsKey: string,
  wrapper: Record<string, unknown> = {},
  truncationHint?: string,
): ArrayResponse {
  const hint = truncationHint ?? DEFAULT_TRUNCATION_HINT;
  const total = items.length;
  const skeleton = JSON.stringify({ ...wrapper, [itemsKey]: [], _meta: { included: 0, total, truncated: true, hint } });
  const budget = CHARACTER_LIMIT - (skeleton.length - 2); // -2 for empty "[]"

  if (budget <= 0) {
    const fallback = jsonResponse({ ...wrapper, [itemsKey]: items }, truncationHint);
    return { ...fallback, _arrayMeta: { includedCount: 0, totalCount: total, truncated: true } };
  }

  const included = items.slice(0, countItemsWithinBudget(items, budget));
  const truncated = included.length < total;

  const result: Record<string, unknown> = { ...wrapper, [itemsKey]: included };
  if (truncated) result._meta = { included: included.length, total, truncated, hint };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    _arrayMeta: { includedCount: included.length, totalCount: total, truncated },
  };
}

export function jsonResponse(data: unknown, truncationHint?: string): ToolResult {
  return { content: [{ type: "text", text: truncateText(JSON.stringify(data), truncationHint ?? undefined) }] };
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
