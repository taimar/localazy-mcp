import { ApiClient } from "@localazy/api-client";

let client: ApiClient | null = null;

export function getClient(): ApiClient {
  if (!client) {
    const token = process.env.LOCALAZY_API_TOKEN;
    if (!token) {
      throw new Error(
        "LOCALAZY_API_TOKEN environment variable is required. " +
        "Get a project token from https://localazy.com/developer/tokens"
      );
    }
    client = new ApiClient({ authToken: token });
  }
  return client;
}
