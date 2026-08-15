import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Protocol-level smoke tests: everything else in the suite imports functions
 * directly, so nothing else would notice if the server stopped speaking MCP.
 *
 * These run the real entry point over a real stdio pipe. They need no API
 * token and no network, because registering tools never calls Localazy —
 * `getClient()` is lazy, so only `tools/call` would need credentials. The
 * child env has the token removed to keep that true.
 *
 * The wire vocabulary below is spelled out rather than imported from the SDK.
 * These tests are worth having only because they speak to the server the way
 * a foreign client does; importing the SDK's own constants and framing would
 * let a rename carry the tests along and keep them green while real clients
 * broke.
 */

const SERVER = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const CLIENT_INFO = { name: "protocol-test", version: "1.0.0" };

/** The opening a 2025-era client sends. That era negotiates with `initialize`. */
const LEGACY_INIT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: CLIENT_INFO,
};

/**
 * The envelope a 2026-07-28 client stamps into `_meta` on every request. All
 * three keys are required: the server answers an incomplete envelope with
 * -32602, which is easy to mistake for the server lacking modern support.
 */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
};

type Response = { result?: any; error?: { code: number; message: string } };

/** A live stdio connection to the server, speaking line-delimited JSON-RPC. */
class Connection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (value: Response) => void>();
  private buffer = "";
  private stderr = "";
  private nextId = 1;

  constructor() {
    const env = { ...process.env };
    delete env.LOCALAZY_API_TOKEN;

    this.child = spawn(process.execPath, ["--import", "tsx", SERVER], { env });

    // Kept so a server that dies on startup reports its reason instead of
    // surfacing as an unexplained send timeout.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      const lines = (this.buffer + chunk.toString()).split("\n");
      this.buffer = lines.pop()!; // Trailing fragment; the rest are complete.

      for (const line of lines) {
        let message: Response & { id?: number };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Blank line, or output the framing does not own.
        }
        if (message.id === undefined) continue;

        const resolve = this.pending.get(message.id);
        if (!resolve) continue;
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }

  send(method: string, params: unknown = {}): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = this.stderr.trim();
        reject(
          new Error(
            `timed out waiting for a response to ${method}` +
            (detail ? `; server stderr: ${detail}` : ""),
          ),
        );
      }, 20_000);

      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
  }

  close(): void {
    this.child.kill();
  }
}

function toolNames(response: Response): string[] {
  return (response.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
}

// Each test spawns its own server, so they have nothing to share and no reason
// to queue behind each other.
describe("protocol", { concurrency: true }, () => {
  test("a 2025-era client can initialize and list tools", { timeout: 30_000 }, async (t) => {
    const connection = new Connection();
    t.after(() => connection.close());

    const initialize = await connection.send("initialize", LEGACY_INIT);

    assert.equal(initialize.error, undefined);
    assert.equal(initialize.result.protocolVersion, "2025-06-18");
    assert.equal(initialize.result.serverInfo.name, "localazy-mcp-server");
    assert.ok(initialize.result.capabilities.tools, "server must advertise the tools capability");
    assert.ok(initialize.result.instructions, "server must send its instructions");

    connection.notify("notifications/initialized");

    const list = await connection.send("tools/list");
    assert.equal(list.error, undefined);

    const names = toolNames(list);
    assert.ok(names.length > 0, "tools/list must not be empty");
    assert.ok(names.includes("localazy_upload_translations"));
    assert.ok(names.includes("localazy_list_languages"));

    // Cache hints arrived with 2026-07-28. This era predates them, and serving
    // them here would mean the factory pinned the wrong era for this client.
    assert.equal(list.result.ttlMs, undefined);
    assert.equal(list.result.cacheScope, undefined);
  });

  test("a 2026-07-28 client can discover and list tools", { timeout: 30_000 }, async (t) => {
    const connection = new Connection();
    t.after(() => connection.close());

    // This era retired `initialize`; a pinned client opens with server/discover.
    const discover = await connection.send("server/discover", { _meta: MODERN_META });

    assert.equal(discover.error, undefined);
    assert.ok(
      discover.result.supportedVersions.includes("2026-07-28"),
      `expected 2026-07-28 in ${JSON.stringify(discover.result.supportedVersions)}`,
    );
    assert.ok(discover.result.capabilities.tools, "server must advertise the tools capability");
    assert.ok(discover.result.instructions, "server must send its instructions");
    assert.equal(
      discover.result._meta["io.modelcontextprotocol/serverInfo"].name,
      "localazy-mcp-server",
      "this era carries server identity in _meta, not at the top level",
    );

    const list = await connection.send("tools/list", { _meta: MODERN_META });
    assert.equal(list.error, undefined);

    const names = toolNames(list);
    assert.ok(names.length > 0, "tools/list must not be empty");
    assert.ok(names.includes("localazy_upload_translations"));
    assert.ok(names.includes("localazy_list_languages"));
  });

  test("both protocol eras serve the same tool surface", { timeout: 30_000 }, async (t) => {
    const legacy = new Connection();
    const modern = new Connection();
    t.after(() => {
      legacy.close();
      modern.close();
    });

    const [legacyNames, modernNames] = await Promise.all([
      (async () => {
        await legacy.send("initialize", LEGACY_INIT);
        legacy.notify("notifications/initialized");
        return toolNames(await legacy.send("tools/list"));
      })(),
      (async () => {
        const discover = await modern.send("server/discover", { _meta: MODERN_META });
        // Without this the test still passes on a 2025-only server, because
        // tools/list answers even when the modern opening was refused.
        assert.equal(discover.error, undefined, "the modern opening must succeed");
        return toolNames(await modern.send("tools/list", { _meta: MODERN_META }));
      })(),
    ]);

    assert.deepEqual(
      modernNames,
      legacyNames,
      "one factory serves both eras, so neither may expose a tool the other does not",
    );
  });

  test("the upload tool is advertised as destructive and non-idempotent", { timeout: 30_000 }, async (t) => {
    const connection = new Connection();
    t.after(() => connection.close());

    const discover = await connection.send("server/discover", { _meta: MODERN_META });
    assert.equal(discover.error, undefined, "the modern opening must succeed");
    const list = await connection.send("tools/list", { _meta: MODERN_META });

    const tools = list.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    const upload = tools.find((tool) => tool.name === "localazy_upload_translations");
    assert.ok(upload, "the upload tool must be registered");

    // See the comment on these annotations in src/tools/import.ts for why.
    assert.equal(upload.annotations?.readOnlyHint, false);
    assert.equal(upload.annotations?.destructiveHint, true);
    assert.equal(upload.annotations?.idempotentHint, false);

    for (const tool of tools.filter((candidate) => candidate !== upload)) {
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name} only reads, so it must say so`,
      );
    }
  });
});
