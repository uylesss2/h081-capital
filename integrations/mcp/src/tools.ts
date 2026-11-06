// The H081 bank operations as MCP tools (one per OPS entry). The bank is opened lazily on the first call that needs it, so
// `tools/list` works (and a missing key is reported as a readable tool error) before any key is loaded.
import type { McpTool } from '../../../src/mcp-core.js';
import { type BankLike, runOp, validateArgs } from '../../core/operations.js';
import { DESCRIPTIONS, JSON_SCHEMA, OPS, type OpName } from '../../core/schemas.js';

export interface ToolContext {
  /** opens (once) and returns the bank; a rejection becomes the tool's error text */
  bank: () => Promise<BankLike>;
}

export function h081Tools(ctx: ToolContext): McpTool[] {
  return OPS.map((name: OpName) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: JSON_SCHEMA[name],
    // validated before the bank opens (and again in runOp): MCP refuses exactly what the Agent Kit refuses
    handler: async (args) => { validateArgs(name, args); return runOp(await ctx.bank(), name, args); },
  }));
}
