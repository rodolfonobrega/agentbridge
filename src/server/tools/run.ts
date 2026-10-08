// Runs one request that carries client tools
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, runToEnd } from '../common.js';
import { emulationPrompt, bridgeInstructions, parseToolCalls, ToolDefinition, ToolChoice } from './emulate.js';

const STUB = fileURLToPath(new URL('./mcp-stub.js', import.meta.url));
const PREFIX = 'mcp__client_tools__';

const withSystem = (o: any, extra: string) => ({
  ...o,
  systemPrompt: [o.systemPrompt, extra].filter(Boolean).join('\n\n'),
});

function safeNames(tools: ToolDefinition[]) {
  const used = new Set<string>(),
    names = new Map<string, string>(),
    list: ToolDefinition[] = [];
  for (const t of tools) {
    let s = t.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool',
      n = 1;
    while (used.has(s)) s = `${s.slice(0, 55)}_${n++}`;
    used.add(s);
    names.set(s, t.name);
    list.push({ name: s, description: t.description, parameters: t.parameters });
  }
  return { names, list };
}

async function viaBridge(o: any, tools: ToolDefinition[], choice?: ToolChoice): Promise<any> {
  const { names, list } = safeNames(tools);
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-tools-'));
  try {
    const file = path.join(dir, 'tools.json');
    writeFileSync(file, JSON.stringify(list));
    const { fallback, ...rest } = o;
    void fallback;
    const r = await runToEnd(
      withSystem(
        {
          ...rest,
          mcpServers: { client_tools: { command: process.execPath, args: [STUB, file] } },
          toolBridge: { prefix: PREFIX, names },
        },
        bridgeInstructions(choice)
      )
    );
    if (r.toolCalls?.length) return r;
    const p = parseToolCalls(r.text, tools);
    return p.calls.length ? { ...r, text: p.text, toolCalls: p.calls, finishReason: 'tool_calls' } : r;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function viaPrompt(o: any, tools: ToolDefinition[], choice?: ToolChoice): Promise<any> {
  const sys = emulationPrompt(tools, choice);
  let r = await runToEnd(withSystem(o, sys));
  let p = parseToolCalls(r.text, tools);
  if (p.error) {
    r = await runToEnd(
      withSystem(
        {
          ...o,
          prompt: `${o.prompt}\n\n[Your previous reply had an invalid tool call: ${p.error}. Reply again with valid <tool_call> blocks, or a plain-text answer.]`,
        },
        sys
      )
    );
    p = parseToolCalls(r.text, tools);
  }
  if (p.calls.length) {
    return { ...r, text: p.text, toolCalls: p.calls, finishReason: 'tool_calls', ...(p.error ? { warning: p.error } : {}) };
  }
  return {
    ...r,
    ...(p.error
      ? { warning: `tool_call_unparsed: ${p.error}` }
      : choice?.mode === 'required' || choice?.mode === 'tool'
      ? { warning: 'tool_call_missing: the model answered without calling a tool' }
      : {}),
  };
}

export async function runTools(o: any, tools: ToolDefinition[], choice?: ToolChoice): Promise<any> {
  if (o.mode === 'agent') {
    throw new HttpError(
      400,
      'Client tools cannot be combined with agent mode: the agent already has its own tools. Use the plain API mode for tool calling.',
      'invalid_request_error',
      'tools_not_supported'
    );
  }
  return o.target.agent === 'claude' ? viaBridge(o, tools, choice) : viaPrompt(o, tools, choice);
}
