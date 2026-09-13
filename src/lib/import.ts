import { importDataFactory, JsonUtils, type ImportJsonRequest } from "@localazy/api-client";
import { invalidateCache } from "./cache.js";
import { getClient } from "./client.js";
import { handleError } from "./errors.js";
import { withRetry, withWriteRetry } from "./retry.js";

/** Keep POST retries separate from the lookup that follows an accepted import. */
export async function uploadJson(request: ImportJsonRequest & { project: string }) {
  const api = getClient();
  const data = importDataFactory(request, JsonUtils.slice(request.json));
  let importBatch: string;
  try {
    const response = await withWriteRetry(() =>
      api.client.post(`/projects/${request.project}/import`, data)
    ) as { result: string };
    importBatch = response.result;
  } finally {
    // Once after the POST settles, including failures that may have landed.
    invalidateCache();
  }
  // Match the SDK's brief delay before looking for a newly created file.
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    const files = await withRetry(() => api.files.list({ project: request.project }));
    const file = files.find((candidate) =>
      candidate.name === (request.fileOptions?.name || "content.json") &&
      candidate.path === request.fileOptions?.path
    );
    if (file) return { ...file, importBatch };
    return { importBatch, warning: "Upload accepted; the file is not visible yet. Do not resend the upload." };
  } catch (error) {
    // The batch exists even if its file cannot be looked up. Report success
    // with that receipt so callers do not repeat an already accepted write.
    return { importBatch, warning: `Upload accepted; file lookup failed. ${handleError(error)} Do not resend the upload.` };
  }
}
