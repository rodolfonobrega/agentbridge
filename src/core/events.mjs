import { AgentError } from './errors.mjs';

// Normalized event constructors + JSONL splitting.
export const ev = {
  session: (id) => ({ type: 'session', id }),
  text: (delta) => ({ type: 'text', delta }),
  thinking: (delta) => ({ type: 'thinking', delta }),
  tool: (name, input, output) => (output === undefined ? { type: 'tool', name, input } : { type: 'tool', name, input, output }),
  usage: (input = 0, output = 0, cost) => (cost === undefined ? { type: 'usage', input, output } : { type: 'usage', input, output, cost }),
  error: (message) => ({ type: 'error', message: String(message) }),
  raw: (data) => ({ type: 'raw', data }),
  /** Emitted by run() when a failed attempt is retried on the next agent of options.fallback. */
  fallback: (from, to, code, message) => ({ type: 'fallback', from, to, code, message: String(message) }),
};

export const EVENT_TYPES = ['session', 'text', 'thinking', 'tool', 'usage', 'error', 'raw', 'fallback'];

/** Parse one line as JSON; returns undefined if blank/not JSON. */
export function parseJsonLine(line) {
  const s = line.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Async-iterate parsed JSON objects from an async iterable of lines. Non-JSON lines are yielded as {__nonjson: line}. */
export async function* jsonlObjects(lines) {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const o = parseJsonLine(line);
    yield o === undefined ? { __nonjson: line } : o;
  }
}

/** Stateful linear-time splitter. push(chunk) -> complete lines; flush() -> remainder.
 *  opts.maxLine: max chars in one line (default 16M); exceeding throws AgentError AGENT_FAILED. */
export function createLineSplitter({ maxLine = 16 * 1024 * 1024 } = {}) {
  let pending = [], plen = 0;
  const over = () => new AgentError('AGENT_FAILED', `Output line exceeded maxLine (${maxLine} chars)`);
  return {
    push(chunk) {
      const out = [];
      let start = 0;
      for (;;) {
        const i = chunk.indexOf(String.fromCharCode(10), start);
        if (i < 0) break;
        let line = pending.length ? pending.join('') + chunk.slice(start, i) : chunk.slice(start, i);
        pending = []; plen = 0;
        if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        out.push(line);
        start = i + 1;
      }
      if (start < chunk.length) {
        const rest = start ? chunk.slice(start) : chunk;
        plen += rest.length;
        if (plen > maxLine) { const err = over(); err.lines = out; throw err; } // lines completed before the overflow are attached, not lost
        pending.push(rest);
      }
      return out;
    },
    flush() {
      const r = pending.join(''); pending = []; plen = 0;
      return r ? [r] : [];
    },
  };
}

/** Split a whole string into jsonl records (skips blanks). */
export function splitJsonl(str) {
  return str.split(/\r?\n/).map(parseJsonLine).filter((x) => x !== undefined);
}
