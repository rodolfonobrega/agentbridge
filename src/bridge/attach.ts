import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('./mcp.js', import.meta.url));

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PassthroughMcpOptions {
  passthrough?: string | string[];
  sourceDir?: string;
  offline?: boolean;
  permissions?: string;
  env?: NodeJS.ProcessEnv;
}

export function getPassthroughMcpServers(opts: PassthroughMcpOptions = {}): Record<string, any> {
  const env = opts.env || process.env;
  const isOffline = opts.offline || env.AGENTBRIDGE_OFFLINE === '1' || env.AGENTBRIDGE_OFFLINE === 'true';
  if (isOffline) return {};

  const perms = opts.permissions || env.AGENTBRIDGE_PERMS || 'read-only';
  if (perms === 'read-only' || perms === 'plan') return {};

  const raw = opts.passthrough ?? env.AGENTBRIDGE_MCP_PASSTHROUGH;
  if (!raw) return {};

  const allowed = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return {};

  const sourceDir = opts.sourceDir || env.AGENTBRIDGE_MCP_SOURCE_DIR || path.join(os.homedir(), '.pi', 'agent');
  const mcpFile = path.join(sourceDir, 'mcp.json');
  if (!existsSync(mcpFile)) return {};

  try {
    const data = JSON.parse(readFileSync(mcpFile, 'utf8'));
    const sourceServers = data?.mcpServers || {};
    const result: Record<string, any> = {};

    for (const [name, cfg] of Object.entries<any>(sourceServers)) {
      if (name.toLowerCase() === 'agentbridge') continue;
      const match = allowed.includes('*') || allowed.includes(name.toLowerCase());
      if (match && cfg && typeof cfg === 'object') {
        result[name] = {
          command: cfg.command,
          args: cfg.args || [],
          env: cfg.env || {},
          exposure: cfg.exposure || 'direct',
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

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
