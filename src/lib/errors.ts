/**
 * The @localazy/api-client throws plain Error objects with messages like:
 * "Request failed with status code 401: Unauthorized"
 * We parse the status code from this pattern for reliable matching.
 */
const STATUS_CODE_PATTERN = /status code (\d{3})/;

export function handleError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    const statusMatch = msg.match(STATUS_CODE_PATTERN);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (statusCode === 401) {
      return "Error: Authentication failed. Check your LOCALAZY_API_TOKEN is valid.";
    }
    if (statusCode === 403) {
      return "Error: Permission denied. Your token may not have access to this resource.";
    }
    if (statusCode === 404) {
      return "Error: Resource not found. Check the project/file ID is correct. Use localazy_list_projects and localazy_list_files to get valid IDs.";
    }
    if (statusCode === 429) {
      return "Error: Rate limit exceeded. Localazy allows 100 requests/min. Wait before retrying.";
    }
    if (statusCode !== null) {
      return `Error: API request failed (HTTP ${statusCode}): ${msg}`;
    }

    return `Error: ${msg}`;
  }

  return `Error: Unexpected error: ${String(error)}`;
}
