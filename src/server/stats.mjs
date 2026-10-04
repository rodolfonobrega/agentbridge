// In-memory usage counters for /admin/usage, plus an optional JSONL log (one line per finished run; no prompts or replies).
import { appendFileSync } from 'node:fs';

export function createStats({ logFile } = {}) {
  const since = new Date().toISOString();
  const by = new Map(); // "agent|model|account|mode" -> counters
  let total = { requests: 0, input: 0, output: 0, ms: 0 };
  return {
    record(r) {
      const k = [r.agent, r.model || '', r.account || '', r.mode].join('|');
      let c = by.get(k);
      if (!c) by.set(k, c = { agent: r.agent, model: r.model, account: r.account, mode: r.mode, requests: 0, input: 0, output: 0, ms: 0, finish: {} });
      for (const t of [c, total]) { t.requests++; t.input += r.input; t.output += r.output; t.ms += r.ms; }
      c.finish[r.finish] = (c.finish[r.finish] || 0) + 1;
      if (logFile) { try { appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...r }) + '\n'); } catch { /* logging must never break a request */ } }
    },
    summary: () => ({ since, total: { ...total, avgMs: total.requests ? Math.round(total.ms / total.requests) : 0 }, groups: [...by.values()] }),
  };
}
