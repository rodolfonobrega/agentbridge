import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MCP = fileURLToPath(new URL('../dist/bridge/mcp.js', import.meta.url));

/** Minimal MCP client over the bridge's stdio. Collects notifications and any non-JSON stdout lines (protocol corruption). */
export function rpc(env = {}, { script = MCP, nodeArgs = [] } = {}) {
  const p = spawn(process.execPath, [...nodeArgs, script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); const notes = []; const bad = []; let buf = ''; let n = 0;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { bad.push(line); continue; }
      if (m.id !== undefined && m.id !== null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else notes.push(m);
    }
  });
  const write = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const call = (method, params, ms = method === 'tools/call' ? 330000 : 30000) => { const id = ++n; return { id, promise: new Promise((res, rej) => { const t = setTimeout(() => { waiting.delete(id); rej(new Error(`rpc timeout (${ms}ms): ${method}`)); }, ms); t.unref?.(); waiting.set(id, (m) => { clearTimeout(t); res(m); }); write({ jsonrpc: '2.0', id, method, params }); }) }; };
  p.on('exit', (code) => { for (const [id, cb] of waiting) { waiting.delete(id); cb({ id, error: { message: `bridge exited (${code})` } }); } });
  return {
    notes, bad, proc: p, write,
    close: () => p.kill(),
    call: (method, params) => call(method, params).promise,
    start: call,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    tool: (name, args, extra) => call('tools/call', { name, arguments: args, ...(extra || {}) }).promise,
  };
}
export const init = (c) => c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
