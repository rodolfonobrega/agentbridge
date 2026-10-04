#!/usr/bin/env node
// Minimal stdio MCP server that exposes the CLIENT's tool schemas to claude. It never executes anything: tools/call returns a
// placeholder, and the proxy stops the CLI as soon as it sees the call, handing it to the API client instead.
// usage: node mcp-stub.mjs <tools.json>   ([{name (safe), description, parameters}])
import { readFileSync } from 'node:fs';

const tools = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const schemaOf = (p) => (p && p.type === 'object' ? p : { type: 'object', properties: {}, ...(p && typeof p === 'object' ? { additionalProperties: true } : {}) });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notifications (initialized, cancelled...) need no answer
    if (m.method === 'initialize') reply(m.id, { protocolVersion: SUPPORTED.includes(m.params?.protocolVersion) ? m.params.protocolVersion : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'client_tools', version: '1' } });
    else if (m.method === 'tools/list') reply(m.id, { tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: schemaOf(t.parameters) })) });
    else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: '(the call was forwarded to the API client)' }] });
    else if (m.method === 'ping') reply(m.id, {});
    else fail(m.id, -32601, `Method not found: ${m.method}`);
  }
});
process.stdin.on('end', () => process.exit(0));
