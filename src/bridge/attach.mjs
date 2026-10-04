import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('./mcp.mjs', import.meta.url));

/**
 * mcpServers entry for the adapters' `mcpServers` option. Works for any caller (claude|codex|opencode).
 * `models` = { callee: model } is enforced server-side (AGENTBRIDGE_MODEL_<CALLEE>), so it cannot be dropped by the calling LLM.
 *
 * IMPORTANT — no secret here. This object becomes the CALLER's own MCP server config, which each adapter's CLI
 * materializes to satisfy its own --mcp-config mechanism: claude writes it into a temp mcp.json that exists for the
 * whole child lifetime, codex serializes it onto its own command line via `-c mcp_servers.*.env=...`. Both are
 * trivially readable by a same-user sibling process (confirmed live: round-7 critic PoC read the key from each).
 * There is therefore no `attestKey` parameter — the attest key MUST instead be set directly on the env of the
 * spawned agent CLI process itself (the `env` field of adapter RunOptions, not this function's return value), which
 * the CLI's own MCP-subprocess spawn inherits from its parent without ever writing it to disk or argv (verified
 * empirically for claude in acceptance/keydelivery.test.mjs "N1 (round 7)"; see that file for the codex result too).
 */
export function mcpConfigFor(callerAgent, opts = {}) {
  const { depth = 0, maxDepth, permissions = 'read-only', models = {}, home, attestBind, root, childCwd, defaultTimeoutS } = opts;
  if (!['claude', 'codex', 'opencode', 'agy', 'pi'].includes(callerAgent)) throw new Error(`Unknown caller agent "${callerAgent}"`);
  const env = { AGENTBRIDGE_DEPTH: String(depth), AGENTBRIDGE_PERMS: permissions };
  if (maxDepth != null) env.AGENTBRIDGE_MAX_DEPTH = String(maxDepth);
  for (const [a, m] of Object.entries(models)) if (m) env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`] = m;
  if (home) env.AGENTBRIDGE_HOME = home;
  if (attestBind) env.AGENTBRIDGE_ATTEST_BIND = attestBind; // not secret: a random nonce, useless for forgery without the HMAC key
  if (root) env.AGENTBRIDGE_ROOT = root;
  if (childCwd) env.AGENTBRIDGE_CHILD_CWD = childCwd; // forces the callee cwd server-side (caller cannot see it)
  if (defaultTimeoutS) env.AGENTBRIDGE_DEFAULT_TIMEOUT_S = String(defaultTimeoutS);
  return { agentbridge: { command: process.execPath, args: [MCP], env } };
}
