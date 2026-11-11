// The Model Context Protocol server core: the JSON-RPC 2.0 methods MCP needs for tools (initialize, ping,
// tools/list, tools/call) over newline-delimited messages, without an SDK dependency and without any chain
// dependency. mcp.ts (EVM stipend tools) and integrations/mcp (Solana H081 bank tools) both build on it.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const POLICY_NOTE =
  'Spending is bounded by the allowance policy the owner set (lifetime cap, window cap, per-payment cap, expiry, ' +
  'recipient allow-list, stream rate): the pool accepts a payment only with a zero-knowledge spend proof, and a ' +
  'payment that breaks the policy has no valid proof, whatever this tool is asked to do.';

/** JSON with bigints as decimal strings and byte arrays as 0x hex. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : v));
}

// ------------------------------------------------------------------ JSON-RPC

export type JsonRpcId = string | number | null;
export interface JsonRpcRequest { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: Record<string, unknown> }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface McpServerInfo {
  name: string;
  version: string;
  /** text the client shows its model after initialize */
  instructions?: string;
  /**
   * structured content for a failed tool call (e.g. a stable error code); default none. When it returns
   * `text`, that replaces the error message the model reads.
   */
  errorContent?: (e: unknown, call: { name: string; args: Record<string, unknown> }) => (Record<string, unknown> & { text?: string }) | undefined;
}

export class McpServer {
  private readonly byName: Map<string, McpTool>;
  readonly info: { name: string; version: string };
  readonly instructions: string;
  private readonly errorContent?: McpServerInfo['errorContent'];

  constructor(readonly tools: McpTool[], info: McpServerInfo = { name: 'stipend', version: '0.1.0' }) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.info = { name: info.name, version: info.version };
    this.errorContent = info.errorContent;
    this.instructions = info.instructions ?? 'Stipend wallet tools. ' + POLICY_NOTE;
  }

  /** Handles one message; returns the response, or undefined for a notification. */
  async handle(msg: unknown): Promise<JsonRpcResponse | undefined> {
    const req = msg as JsonRpcRequest;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: (req as { id?: JsonRpcId })?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    }
    const isNotification = req.id === undefined;
    const reply = (result: unknown): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: '2.0', id: req.id!, result });
    const fail = (code: number, message: string): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: '2.0', id: req.id!, error: { code, message } });
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '');
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: this.instructions,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const tool = this.byName.get(name);
        if (!tool) return fail(-32602, `unknown tool: ${name}`);
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = await tool.handler(args);
          const text = toJson(out);
          return reply({ content: [{ type: 'text', text }], structuredContent: JSON.parse(text), isError: false });
        } catch (e) {
          // a tool failure (a refused proof, a bad argument) is a result the model can read, not a protocol error
          let structured: (Record<string, unknown> & { text?: string }) | undefined;
          try { structured = this.errorContent?.(e, { name, args }); } catch { structured = undefined; }
          let text = (e as Error).message;
          if (structured && typeof structured.text === 'string') { const { text: t, ...rest } = structured; text = t; structured = rest; }
          return reply({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), isError: true });
        }
      }
      default:
        if (req.method.startsWith('notifications/')) return undefined;
        return fail(-32601, `method not found: ${req.method}`);
    }
  }

  /**
   * Serves newline-delimited JSON-RPC on the streams (stdin/stdout by default) until input ends. Messages are
   * handled one at a time: two operations from one account must not race for the same note.
   */
  serveStdio(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let queue: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        let msg: unknown;
        try { msg = JSON.parse(line); } catch {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
          return;
        }
        const batch = Array.isArray(msg) ? msg : [msg];
        const replies: JsonRpcResponse[] = [];
        for (const m of batch) { const r = await this.handle(m); if (r) replies.push(r); }
        if (replies.length) output.write(toJson(Array.isArray(msg) ? replies : replies[0]) + '\n');
      });
    });
    return new Promise((resolve) => rl.on('close', () => { void queue.then(() => resolve()); }));
  }
}
