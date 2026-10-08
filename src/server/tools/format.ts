// Client-side tool calling: request parsing (OpenAI chat / Responses / Anthropic) into one internal shape
import { HttpError, contentText } from '../common.js';
import { ToolDefinition, ToolChoice, ParsedToolCall } from './emulate.js';

const bad = (m: string, code = 'tools_not_supported') => new HttpError(400, m, 'invalid_request_error', code);
const NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function mkTool(name: string, description?: string, parameters?: any): ToolDefinition {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad(`Invalid tool name ${JSON.stringify(name)}`, 'invalid_tool');
  const p = parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} };
  return { name, description: typeof description === 'string' ? description : '', parameters: p };
}

// ---------- tools + tool_choice ----------
export function toolsFromChat(body: any): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t?.type !== 'function' || !t.function) throw bad(`Tool type "${t?.type}" is not supported (only function tools)`);
    out.push(mkTool(t.function.name, t.function.description, t.function.parameters));
  }
  for (const f of Array.isArray(body.functions) ? body.functions : []) {
    out.push(mkTool(f.name, f.description, f.parameters));
  }
  return out;
}

export function toolsFromResponses(body: any): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t?.type !== 'function') throw bad(`Tool type "${t?.type}" is not supported (only function tools; hosted tools such as web_search are not available)`);
    out.push(mkTool(t.name, t.description, t.parameters));
  }
  return out;
}

export function toolsFromAnthropic(body: any): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t?.type && t.type !== 'custom') throw bad(`Tool type "${t.type}" is not supported (only custom tools; server tools such as web_search are not available)`);
    out.push(mkTool(t.name, t.description, t.input_schema));
  }
  return out;
}

export function choiceFrom(c: any, fnChoice?: any): ToolChoice {
  const v = c ?? fnChoice;
  if (v == null || v === 'auto') return { mode: 'auto' };
  if (v === 'none') return { mode: 'none' };
  if (v === 'required' || v === 'any') return { mode: 'required' };
  if (typeof v === 'object') {
    if (v.type === 'auto') return { mode: 'auto' };
    if (v.type === 'none') return { mode: 'none' };
    if (v.type === 'any') return { mode: 'required' };
    const name = v.function?.name ?? v.name;
    if (name) return { mode: 'tool', name };
  }
  throw bad(`Unsupported tool_choice ${JSON.stringify(v)}`, 'invalid_tool_choice');
}

// ---------- history rendering ----------
export const renderCall = (c: any): string =>
  `<tool_call>${JSON.stringify({ id: c.id, name: c.name, arguments: c.arguments })}</tool_call>`;
export const renderResult = (id: any, name?: string, content?: any): string =>
  `<tool_result id=${JSON.stringify(String(id ?? ''))}${name ? ` name=${JSON.stringify(name)}` : ''}>\n${content}\n</tool_result>`;
const parseArgs = (a: any) => {
  if (a && typeof a === 'object') return a;
  try {
    const v = JSON.parse(a || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const join = (...p: (string | null | undefined)[]) => p.filter((x) => x !== '' && x != null).join('\n');

export interface Turn {
  role: string;
  text: string;
}

export interface ChatTurnsResult {
  sys: string[];
  turns: Turn[];
}

/** OpenAI chat messages -> {sys, turns}. */
export function chatTurns(messages: any[]): ChatTurnsResult {
  const sys: string[] = [],
    turns: Turn[] = [],
    names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      sys.push(contentText(m.content));
      continue;
    }
    if (m.role === 'user') {
      turns.push({ role: 'user', text: contentText(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c: any) => ({
        id: c.id,
        name: c.function?.name,
        arguments: parseArgs(c.function?.arguments),
      }));
      if (m.function_call) {
        calls.push({
          id: 'call_legacy',
          name: m.function_call.name,
          arguments: parseArgs(m.function_call.arguments),
        });
      }
      for (const c of calls) names.set(c.id, c.name);
      turns.push({ role: 'assistant', text: join(contentText(m.content), ...calls.map(renderCall)) });
      continue;
    }
    if (m.role === 'tool') {
      turns.push({
        role: 'tool',
        text: renderResult(m.tool_call_id, names.get(m.tool_call_id), contentText(m.content)),
      });
      continue;
    }
    if (m.role === 'function') {
      turns.push({ role: 'tool', text: renderResult('call_legacy', m.name, contentText(m.content)) });
      continue;
    }
    throw new HttpError(400, `Unsupported message role "${m.role}"`, 'invalid_request_error', 'invalid_role');
  }
  return { sys, turns };
}

/** Anthropic content blocks of one message -> turns. */
export function anthropicTurns(role: string, content: any, names: Map<string, string>): Turn[] {
  if (typeof content === 'string' || !Array.isArray(content)) return [{ role, text: contentText(content) }];
  const turns: Turn[] = [],
    text: string[] = [],
    calls: any[] = [];
  const flush = () => {
    if (text.length || calls.length) turns.push({ role, text: join(...text, ...calls.map(renderCall)) });
    text.length = 0;
    calls.length = 0;
  };
  for (const b of content) {
    if (b?.type === 'tool_use') {
      names.set(b.id, b.name);
      calls.push({ id: b.id, name: b.name, arguments: b.input || {} });
    } else if (b?.type === 'tool_result') {
      flush();
      const body = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? contentText(b.content) : '';
      turns.push({
        role: 'tool',
        text: renderResult(b.tool_use_id, names.get(b.tool_use_id), (b.is_error ? '[error] ' : '') + body),
      });
    } else if (b?.type === 'server_tool_use' || b?.type === 'web_search_tool_result') {
      throw bad('Server tools are not supported by the agentbridge proxy');
    } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
      continue;
    } else {
      text.push(contentText([b]));
    }
  }
  flush();
  return turns;
}

/** Responses input items (function_call / function_call_output) -> turns. */
export function responsesToolTurn(it: any, names: Map<string, string>): Turn | null {
  if (it.type === 'function_call') {
    names.set(it.call_id, it.name);
    return {
      role: 'assistant',
      text: renderCall({ id: it.call_id, name: it.name, arguments: parseArgs(it.arguments) }),
    };
  }
  if (it.type === 'function_call_output') {
    return {
      role: 'tool',
      text: renderResult(it.call_id, names.get(it.call_id), typeof it.output === 'string' ? it.output : JSON.stringify(it.output)),
    };
  }
  return null;
}

// ---------- response builders ----------
const argsJson = (c: any) => JSON.stringify(c.arguments ?? {});
export const anthropicId = (id: any) => String(id).replace(/^call_/, 'toolu_');

export const chatToolCalls = (calls: ParsedToolCall[]) =>
  calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: argsJson(c) } }));
export const chatToolDeltas = (calls: ParsedToolCall[]) =>
  calls.map((c, i) => [
    { index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } },
    { index: i, function: { arguments: argsJson(c) } },
  ]);
export const responsesItems = (calls: ParsedToolCall[], newId: (prefix: string) => string) =>
  calls.map((c) => ({
    id: newId('fc_'),
    type: 'function_call',
    status: 'completed',
    call_id: c.id,
    name: c.name,
    arguments: argsJson(c),
  }));
export const anthropicBlocks = (calls: ParsedToolCall[]) =>
  calls.map((c) => ({ type: 'tool_use', id: anthropicId(c.id), name: c.name, input: c.arguments ?? {} }));
