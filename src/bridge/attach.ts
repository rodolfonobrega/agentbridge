import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('./mcp.js', import.meta.url));

export interface McpConfigOptions {
  depth?: number;
  maxDepth?: number;
  permissions?: string;
  models?: Record<string, string | undefined>;
  home?: string;
  attestBind?: string;
  root?: string;
  childCwd?: string;
  defaultTimeoutS?: number | string;
}

export interface McpConfigResult {
  agentbridge: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

/**
 * mcpServers entry for the adapters' `mcpServers` option. Works for any caller (claude|codex|opencode).
 * `models` = { callee: model } is enforced server-side (AGENTBRIDGE_MODEL_<CALLEE>), so it cannot be dropped by the calling LLM.
 */
export function mcpConfigFor(callerAgent: string, opts: McpConfigOptions = {}): McpConfigResult {
  const { depth = 0, maxDepth, permissions = 'full', models = {}, home, attestBind, root, childCwd, defaultTimeoutS } = opts;
  if (!['claude', 'codex', 'opencode', 'agy', 'pi'].includes(callerAgent)) {
    throw new Error(`Unknown caller agent "${callerAgent}"`);
  }
  const env: Record<string, string> = { AGENTBRIDGE_DEPTH: String(depth), AGENTBRIDGE_PERMS: permissions };
  if (maxDepth != null) env.AGENTBRIDGE_MAX_DEPTH = String(maxDepth);
  for (const [a, m] of Object.entries(models)) {
    if (m) env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`] = m;
  }
  if (home) env.AGENTBRIDGE_HOME = home;
  if (attestBind) env.AGENTBRIDGE_ATTEST_BIND = attestBind;
  if (root) env.AGENTBRIDGE_ROOT = root;
  if (childCwd) env.AGENTBRIDGE_CHILD_CWD = childCwd;
  if (defaultTimeoutS) env.AGENTBRIDGE_DEFAULT_TIMEOUT_S = String(defaultTimeoutS);
  return { agentbridge: { command: process.execPath, args: [MCP], env } };
}
