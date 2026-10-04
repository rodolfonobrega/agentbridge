import { createHash, randomBytes } from 'node:crypto';
import { run } from '../index.mjs';
import { mcpConfigFor } from './attach.mjs';
import { verifyAttestation, serveHttp } from './mcp.mjs';

const str = (o) => (o === undefined || typeof o === 'string' ? o : (() => { try { return JSON.stringify(o); } catch { return String(o); } })());
const sha = (t) => createHash('sha256').update(String(t ?? '')).digest('hex');

/**
 * Find a server attestation in a tool result and VERIFY it (HMAC with the launcher's key + sha256 of the returned text).
 * Returns the attestation or null. Anything the callee's text says (fake "[agentbridge] {...}" lines) fails verification.
 */
export function bridgeMeta(output, key, { bind, seen, promptSha } = {}) {
  const s = str(output) || '';
  if (!key) return null;
  const cands = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.structuredContent) walk(o.structuredContent);
    if (o.attestation) cands.push({ a: o.attestation, text: o.text });
    if (Array.isArray(o.content)) {
      const t0 = o.content[0]?.text;
      for (const c of o.content) { const m = /^\[agentbridge\] (\{.*\})\s*$/s.exec(c?.text || ''); if (m) try { cands.push({ a: JSON.parse(m[1]), text: t0 }); } catch { /* skip */ } }
    }
  };
  try { walk(JSON.parse(s)); } catch { /* not json */ }
  if (!cands.length) {
    const u = s.replace(/\\"/g, '"');
    for (const m of u.matchAll(/\{"agent":"[^{}]*"hmac":"[0-9a-f]{64}"\}/g)) try { cands.push({ a: JSON.parse(m[0]), text: u.slice(0, m.index).replace(/\s*\[agentbridge\] $/, '') }); } catch { /* skip */ }
  }
  for (const { a, text } of cands) {
    if (text === undefined || !verifyAttestation(a, key, text)) continue;
    if (bind !== undefined && a.bind !== bind) continue;           // bound to THIS launch: attestations from other runs are rejected
    if (promptSha !== undefined && a.promptSha !== promptSha) continue; // bound to the exact prompt the caller sent
    if (seen) { if (seen.has(a.callId)) continue; seen.add(a.callId); } // one-time use: replays rejected
    return a;
  }
  return null;
}

/**
 * Launch `caller` with the bridge attached, telling it to delegate `task` to `callee` via ask_<callee>.
 * `calleeModel` / `childCwd` are enforced by the bridge server (env), not requested in the prompt.
 * Proof = a verified server attestation (HMAC key held only by this process + the bridge server env) in a successful tool result.
 */
async function runOnce({ maxAttempts, caller, callee, task, model, effort, permissions = 'read-only', cwd, timeoutMs, depth = 0, maxDepth, onEvent, calleeModel, home, toolName, childCwd, attestKey = randomBytes(24).toString('hex'), root, ...rest }) {
  const bind = randomBytes(12).toString('hex'), seen = new Set();
  const tool = toolName || `ask_${callee}`;
  const prompt = `You MUST call the MCP tool "${tool}" (server "agentbridge") exactly once, passing this as its "prompt" argument, verbatim:\n\n${task}\n\nPass ONLY the "prompt" argument (no model, session or other arguments). Then reply with the tool's returned text and nothing else. Do not answer yourself.`;
  const events = [];
  // Round 7/8 / N1: the attest key is NEVER passed into mcpConfigFor by default (that config becomes a temp mcp.json for
  // claude, or a `-c ...env=...` cmdline flag for codex — both readable by a same-user sibling for the caller's whole
  // lifetime). It goes only into the CALLER CLI process's own env below; for claude and opencode that process's own
  // MCP-subprocess spawn inherits it from there without ever touching disk or argv — verified empirically
  // (acceptance/keydelivery.test.mjs). codex's own MCP-subprocess spawn does NOT inherit parent env at all (also verified
  // there): so for codex the bridge is instead run IN THIS PROCESS over streamable-HTTP, and codex is given only the URL
  // plus the NAME of an env var to read for a bearer token (`bearer_token_env_var`) — codex reads the actual value from its
  // own process env (set below, same safe channel) at request time, so the value itself is never in codex's config/argv.
  let httpBridge = null, mcp = {};
  if (caller === 'codex') {
    const grandchildEnv = { AGENTBRIDGE_DEPTH: String(depth), AGENTBRIDGE_PERMS: permissions, AGENTBRIDGE_ATTEST_KEY: attestKey, AGENTBRIDGE_ATTEST_BIND: bind };
    if (maxDepth != null) grandchildEnv.AGENTBRIDGE_MAX_DEPTH = String(maxDepth);
    if (calleeModel) grandchildEnv[`AGENTBRIDGE_MODEL_${callee.toUpperCase()}`] = calleeModel;
    if (home) grandchildEnv.AGENTBRIDGE_HOME = home;
    if (root) grandchildEnv.AGENTBRIDGE_ROOT = root;
    if (childCwd) grandchildEnv.AGENTBRIDGE_CHILD_CWD = childCwd;
    httpBridge = await serveHttp({ env: grandchildEnv });
    rest.extraArgs = [...(rest.extraArgs || []), '-c', `mcp_servers.agentbridge.url="${httpBridge.url}"`, '-c', 'mcp_servers.agentbridge.bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY"', '-c', 'mcp_servers.agentbridge.default_tools_approval_mode="approve"'];
  } else {
    mcp = mcpConfigFor(caller, { depth, maxDepth, permissions, models: calleeModel ? { [callee]: calleeModel } : {}, home, attestBind: bind, root, childCwd });
  }
  const it = run(caller, {
    prompt, model, effort, permissions, cwd, timeoutMs, ...rest,
    env: { AGENTBRIDGE_DEPTH: String(depth), AGENTBRIDGE_PERMS: permissions, AGENTBRIDGE_ATTEST_KEY: attestKey, ...(rest.env || {}) },
    mcpServers: { ...mcp, ...(rest.mcpServers || {}) },
  });
  let result;
  try {
    for (;;) {
      const x = await it.next();
      if (x.done) { result = x.value; break; }
      let e = x.value;
      if (e.type === 'raw') continue;
      if (e.type === 'tool') e = { ...e, output: str(e.output) }; // codex adapter yields objects; normalize
      events.push(e); onEvent?.(e);
    }
  } finally {
    if (httpBridge) await httpBridge.close();
  }
  const toolCalls = events.filter((e) => e.type === 'tool' && String(e.name).includes(tool));
  const promptOf = (e) => (typeof e.input === 'string' ? (() => { try { return JSON.parse(e.input).prompt; } catch { return undefined; } })() : e.input?.prompt);
  const withInput = toolCalls.filter((e) => e.input !== undefined);
  // tool results are matched to the caller's call: verify promptSha against every prompt the caller actually sent
  const sent = withInput.map((e) => promptOf(e)).filter((p) => typeof p === 'string').map((p) => createHash('sha256').update(p).digest('hex'));
  const results = toolCalls.filter((e) => e.output !== undefined).map((e) => {
    let meta = null;
    if (sent.length) { for (const ps of sent) { meta = bridgeMeta(e.output, attestKey, { bind, seen, promptSha: ps }); if (meta) break; } } else meta = bridgeMeta(e.output, attestKey, { bind, seen });
    return { ...e, meta };
  });
  const ok = results.filter((e) => e.meta);
  return { result, text: result.text, events, toolCalls, results, succeeded: ok.length > 0, meta: ok[0]?.meta || null, toolOutput: ok[0]?.output || null, delegated: ok.length > 0, attestKey, bind };
}

/**
 * Public entry. A caller LLM (observed: codex/gpt-5.6-luna, ~1 in 6) occasionally ends its turn with an EMPTY final message even though the
 * delegated tool call succeeded and was attested. Such runs are retried once with a fresh key/bind (attempts are reported, never hidden).
 */
export async function runAsSubagent(opts) {
  const maxAttempts = opts.maxAttempts ?? 2;
  let r, attempts = 0;
  do { r = await runOnce(opts); attempts++; } while (!String(r.text || '').trim() && attempts < maxAttempts);
  r.attempts = attempts;
  return r;
}
