import { CHARACTER_LIMIT } from "../constants.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ArrayResponseMeta = {
  includedCount: number;
  totalCount: number;
  truncated: boolean;
};

export type ArrayResponse = ToolResult & { _arrayMeta: ArrayResponseMeta };

function truncateText(text: string, hint = "Use pagination or filters to reduce results."): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = `\n\n... [TRUNCATED] Response exceeded ${CHARACTER_LIMIT} characters. ${hint}`;
  return text.slice(0, Math.max(0, CHARACTER_LIMIT - suffix.length)) + suffix;
}

/** Fit serialized JSON fragments into a character budget. Returns [fitted, totalCount]. */
function fitWithinBudget(fragments: string[], budget: number): [string[], number] {
  const fitted: string[] = [];
  let used = 0;
  for (const f of fragments) {
    const cost = f.length + (fitted.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    fitted.push(f);
    used += cost;
  }
  return [fitted, fragments.length];
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
  const hint = truncationHint ?? "Use pagination or filters to reduce results.";
  const skeleton = JSON.stringify({ ...wrapper, [itemsKey]: [], _meta: { included: 0, total: items.length, truncated: true, hint } });
  const budget = CHARACTER_LIMIT - (skeleton.length - 2); // -2 for empty "[]"

  if (budget <= 0) {
    const fallback = jsonResponse({ ...wrapper, [itemsKey]: items }, truncationHint);
    return { ...fallback, _arrayMeta: { includedCount: 0, totalCount: items.length, truncated: true } };
  }

  const [fitted, total] = fitWithinBudget(items.map(i => JSON.stringify(i)), budget);
  const included = fitted.map(f => JSON.parse(f));
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
