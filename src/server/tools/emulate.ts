// Tool calling for agents that cannot take the client's tools natively
import { randomBytes } from 'node:crypto';
import { validate } from '../../extras/schema.js';

export const callId = (): string => 'call_' + randomBytes(12).toString('hex');

const choiceLine = (choice?: { mode?: string; name?: string }): string =>
  choice?.mode === 'required'
    ? '\nYou MUST call at least one tool in this reply.'
    : choice?.mode === 'tool'
    ? `\nYou MUST call the tool "${choice.name}" in this reply.`
    : '';

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: any;
}

export interface ToolChoice {
  mode: 'auto' | 'none' | 'required' | 'tool';
  name?: string;
}

export function emulationPrompt(tools: ToolDefinition[], choice?: ToolChoice): string {
  return `You can call tools. Available tools (JSON Schema for each tool's arguments):
<tools>
${tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })).join('\n')}
</tools>

To call a tool, reply with one or more blocks in exactly this form and nothing after them:
<tool_call>{"name": "<tool name>", "arguments": { ... }}</tool_call>
The arguments must satisfy the tool's schema. If no tool is needed, answer normally in plain text (no <tool_call>).
Earlier tool calls and their results appear in the conversation as <tool_call> and <tool_result> blocks; the result of a call is only available in a later turn, so never invent results.${choiceLine(
    choice
  )}`;
}

export function bridgeInstructions(choice?: ToolChoice): string {
  return `You have client tools available through the native tool-calling mechanism: call them when they help. Earlier tool calls and results in the conversation are shown as <tool_call> / <tool_result> blocks for context only; do not write such blocks yourself.${choiceLine(
    choice
  )}`;
}

/** First balanced {...} object in s, parsed; undefined if none. */
function firstObject(s: string): any {
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ParseToolCallsResult {
  text: string;
  calls: ParsedToolCall[];
  error?: string;
}

/**
 * -> {text, calls: [{id,name,arguments}], error?}. `text` is what preceded the first <tool_call>.
 */
export function parseToolCalls(reply: string, tools: ToolDefinition[]): ParseToolCallsResult {
  const i = reply.indexOf('<tool_call>');
  if (i < 0) return { text: reply, calls: [] };
  const text = reply.slice(0, i).trim();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const lower = new Map(tools.map((t) => [t.name.toLowerCase(), t]));
  const calls: ParsedToolCall[] = [];
  const errors: string[] = [];
  for (const seg of reply.slice(i).split('<tool_call>').slice(1)) {
    const body = seg.split('</tool_call>')[0].replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let o: any;
    try {
      o = JSON.parse(body);
    } catch {
      o = firstObject(body);
    }
    if (!o || typeof o !== 'object') {
      errors.push(`a <tool_call> block is not valid JSON: ${body.slice(0, 80)}`);
      continue;
    }
    const name = o.name ?? o.tool ?? o.function;
    const tool = byName.get(name) || lower.get(String(name).toLowerCase());
    if (!tool) {
      errors.push(`unknown tool ${JSON.stringify(name)} (available: ${tools.map((t) => t.name).join(', ')})`);
      continue;
    }
    let args = o.arguments ?? o.parameters ?? o.input ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        errors.push(`arguments of ${tool.name} are not valid JSON`);
        continue;
      }
    }
    const errs = validate(tool.parameters, args);
    if (errs.length) {
      errors.push(`arguments of ${tool.name} are invalid: ${errs.slice(0, 3).join('; ')}`);
      continue;
    }
    calls.push({ id: callId(), name: tool.name, arguments: args });
  }
  return { text, calls, ...(errors.length ? { error: errors.join(' | ') } : {}) };
}
