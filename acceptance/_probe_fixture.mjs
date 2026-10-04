#!/usr/bin/env node
// Dumps this process's env to a file the instant it starts (before any handshake), then serves a minimal MCP
// handshake so the calling CLI's tool-discovery doesn't error out. Used to empirically observe what env a
// caller CLI's own MCP-subprocess spawn actually gives its children, with no dependence on the bridge itself.
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
writeFileSync(out, JSON.stringify(process.env));
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } } }) + '\n');
    else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\n');
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
  }
});
