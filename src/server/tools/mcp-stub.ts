#!/usr/bin/env node
// Minimal stdio MCP server that exposes the CLIENT's tool schemas to claude.
import { readFileSync } from 'node:fs';

const tools: any[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const reply = (id: any, result: any) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id: any, code: number, message: string) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const schemaOf = (p: any) =>
  p && p.type === 'object'
    ? p
    : { type: 'object', properties: {}, ...(p && typeof p === 'object' ? { additionalProperties: true } : {}) };

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === undefined) continue;
    if (m.method === 'initialize') {
      reply(m.id, {
        protocolVersion: SUPPORTED.includes(m.params?.protocolVersion) ? m.params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'client_tools', version: '1' },
      });
    } else if (m.method === 'tools/list') {
      reply(m.id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: schemaOf(t.parameters) })),
      });
    } else if (m.method === 'tools/call') {
      reply(m.id, { content: [{ type: 'text', text: '(the call was forwarded to the API client)' }] });
    } else if (m.method === 'ping') {
      reply(m.id, {});
    } else {
      fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
