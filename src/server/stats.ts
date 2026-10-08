// In-memory usage counters for /admin/usage, plus an optional JSONL log.
import { appendFileSync } from 'node:fs';

export interface UsageRecord {
  agent: string;
  model?: string | null;
  account?: string | null;
  mode: string;
  requests?: number;
  input: number;
  output: number;
  ms: number;
  finish: string;
  [key: string]: any;
}

export interface StatsGroup {
  agent: string;
  model?: string | null;
  account?: string | null;
  mode: string;
  requests: number;
  input: number;
  output: number;
  ms: number;
  finish: Record<string, number>;
}

export interface StatsSummary {
  since: string;
  total: {
    requests: number;
    input: number;
    output: number;
    ms: number;
    avgMs: number;
  };
  groups: StatsGroup[];
}

export interface StatsTracker {
  record: (r: UsageRecord) => void;
  summary: () => StatsSummary;
}

export function createStats({ logFile }: { logFile?: string } = {}): StatsTracker {
  const since = new Date().toISOString();
  const by = new Map<string, StatsGroup>();
  let total = { requests: 0, input: 0, output: 0, ms: 0 };
  return {
    record(r: UsageRecord) {
      const k = [r.agent, r.model || '', r.account || '', r.mode].join('|');
      let c = by.get(k);
      if (!c) {
        c = {
          agent: r.agent,
          model: r.model,
          account: r.account,
          mode: r.mode,
          requests: 0,
          input: 0,
          output: 0,
          ms: 0,
          finish: {},
        };
        by.set(k, c);
      }
      for (const t of [c, total]) {
        t.requests++;
        t.input += r.input;
        t.output += r.output;
        t.ms += r.ms;
      }
      c.finish[r.finish] = (c.finish[r.finish] || 0) + 1;
      if (logFile) {
        try {
          appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...r }) + '\n');
        } catch {
          /* ignore */
        }
      }
    },
    summary: (): StatsSummary => ({
      since,
      total: { ...total, avgMs: total.requests ? Math.round(total.ms / total.requests) : 0 },
      groups: [...by.values()],
    }),
  };
}
