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
 * The envelope a 2026-07-28 client stamps into `_meta` on every request.
 *
 * `protocolVersion` is what selects the era: without it the server reads the
 * request as a 2025-era opening, and `server/discover` comes back -32601.
 * `clientCapabilities` is required, and leaving it out gives -32602, which is
 * easy to mistake for the server lacking modern support. `clientInfo` is
 * recommended rather than required, which the modern test below checks.
 */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
};

type Response = { result?: any; error?: { code: number; message: string } };
type Pending = { resolve: (value: Response) => void; reject: (error: Error) => void };

/** A live stdio connection to the server, speaking line-delimited JSON-RPC. */
class Connection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private violation: string | null = null;
  private nextId = 1;

  constructor(args: string[] = ["--import", "tsx", SERVER]) {
    const env = { ...process.env };
    delete env.LOCALAZY_API_TOKEN;

    this.child = spawn(process.execPath, args, { env });

    // Kept so a server that dies on startup reports its reason instead of
    // surfacing as an unexplained send timeout.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      const lines = (this.buffer + chunk.toString()).split("\n");
      this.buffer = lines.pop()!; // Trailing fragment; the rest are complete.

      for (const line of lines) {
        if (!line) continue; // An artifact of the split, not output.

        // stdout carries the JSON-RPC stream and nothing else, so a stray
        // console.log in the server breaks every real client. It has to break
        // these tests too, rather than being stepped over until a valid
        // response arrives. Diagnostics belong on stderr.
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          this.abort(`server wrote a non-JSON line to stdout: ${JSON.stringify(line)}`);
          return;
        }
        // Parsing is not enough. `{}` or a quoted string is valid JSON and
        // would otherwise pass for a notification. The SDK never batches, so
        // an array is junk here as well.
        if (message?.jsonrpc !== "2.0") {
          this.abort(`server wrote a non-JSON-RPC line to stdout: ${JSON.stringify(line)}`);
          return;
        }
        if (message.id === undefined) continue; // A notification: nothing to correlate.

        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    });
  }

  /** Fails every waiting request, and every later one, with the same reason. */
  private abort(reason: string): void {
    this.violation ??= reason;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  send(method: string, params: unknown = {}): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.violation) {
        reject(new Error(this.violation));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        const detail = this.stderr.trim();
        reject(
          new Error(
            `timed out waiting for a response to ${method}` +
            (detail ? `; server stderr: ${detail}` : ""),
          ),
        );
      }, 20_000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
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

// Sequential on purpose. These tests share nothing and are correct in parallel,
// but starting every server at once starves the real-timer assertions in the
// RateLimiter suite, which `node --test` runs in a parallel process, and made
// the full suite fail about one run in ten. Nothing is lost by waiting: the
// unit file is slower than this one, so it sets the wall time either way.
describe("protocol", () => {
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

    // clientInfo is recommended, not required, so a client that omits it is
    // still served. Leaving out clientCapabilities is what earns a -32602.
    const { "io.modelcontextprotocol/clientInfo": _omitted, ...withoutClientInfo } = MODERN_META;
    const anonymous = await connection.send("tools/list", { _meta: withoutClientInfo });
    assert.equal(anonymous.error, undefined);
    assert.deepEqual(toolNames(anonymous), names);
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

  // Guards the harness itself. If either of these passes by skipping the bad
  // line, every other test in this file goes quiet about a corrupted stream.
  // The second is the one plain JSON.parse cannot catch: it parses, and without
  // a JSON-RPC check it reads as a notification.
  for (const [label, junk] of [
    ["a non-JSON line", "starting"],
    ["valid JSON that is not JSON-RPC", "{}"],
  ]) {
    test(`a server that writes ${label} to stdout fails`, { timeout: 30_000 }, async (t) => {
      const connection = new Connection([
        "-e",
        `console.log(${JSON.stringify(junk)}); setInterval(() => {}, 1000);`,
      ]);
      t.after(() => connection.close());

      await assert.rejects(() => connection.send("tools/list"), /stdout/);
    });
  }

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
