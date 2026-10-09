// Shared Project Memory for AgentBridge.
// Persists repository rules, architectural decisions, and variables
// to <cwd>/.agentbridge/memory.json with fallback to ~/.agentbridge/memory/<repoHash>.json.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { home } from '../bridge/runs.js';
import { UsageError } from '../cli/args.js';
import { findProjectRoot } from '../core/config.js';

export interface MemoryDecision {
  topic: string;
  decision: string;
  agent?: string;
  createdAt: number;
}

export interface ProjectMemory {
  repoPath: string;
  updatedAt: number;
  rules: string[];
  decisions: MemoryDecision[];
  variables: Record<string, string>;
}

export function canonicalPath(p: string): string {
  try {
    p = realpathSync(path.resolve(p));
  } catch {
    p = path.resolve(p);
  }
  if (process.platform === 'win32') {
    p = p.toLowerCase();
  }
  return path.normalize(p);
}

export function getRepoHash(repoPath: string): string {
  return createHash('sha256').update(canonicalPath(repoPath)).digest('hex');
}

export function getMemoryFilePath(cwd?: string): string {
  const repoPath = findProjectRoot(cwd || process.cwd());
  return path.join(repoPath, '.agentbridge', 'memory.json');
}

export function getFallbackMemoryFilePath(cwd?: string): string {
  const repoPath = findProjectRoot(cwd || process.cwd());
  const hash = getRepoHash(repoPath);
  return path.join(home(), 'memory', `${hash}.json`);
}

function writeAtomicJson(filePath: string, obj: any): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (err: any) {
    try {
      writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      unlinkSync(tmp);
    } catch (fallbackErr: any) {
      try { unlinkSync(tmp); } catch {}
      throw new Error(`Failed to write atomic file "${filePath}": ${fallbackErr.message || err.message}`);
    }
  }
}

export function loadMemory(cwd?: string): ProjectMemory {
  const repoPath = findProjectRoot(cwd || process.cwd());
  const localFile = getMemoryFilePath(repoPath);
  const fallbackFile = getFallbackMemoryFilePath(repoPath);

  let localData: any = null;
  let fallbackData: any = null;

  if (existsSync(localFile)) {
    try {
      localData = JSON.parse(readFileSync(localFile, 'utf8'));
    } catch {
      // Local file corrupted or unreadable; attempt fallback
    }
  }

  if (existsSync(fallbackFile)) {
    try {
      fallbackData = JSON.parse(readFileSync(fallbackFile, 'utf8'));
    } catch {
      // Fallback file corrupted or unreadable
    }
  }

  let data: any = null;
  if (localData && fallbackData) {
    const localTime = typeof localData.updatedAt === 'number' ? localData.updatedAt : 0;
    const fallbackTime = typeof fallbackData.updatedAt === 'number' ? fallbackData.updatedAt : 0;
    data = fallbackTime > localTime ? fallbackData : localData;
  } else {
    data = localData || fallbackData;
  }

  if (!data || typeof data !== 'object') {
    return {
      repoPath,
      updatedAt: 0,
      rules: [],
      decisions: [],
      variables: {},
    };
  }

  return {
    repoPath: typeof data.repoPath === 'string' ? data.repoPath : repoPath,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    rules: Array.isArray(data.rules) ? data.rules : [],
    decisions: Array.isArray(data.decisions) ? data.decisions : [],
    variables: data.variables && typeof data.variables === 'object' ? data.variables : {},
  };
}

export function saveMemory(mem: ProjectMemory, cwd?: string): void {
  const repoPath = findProjectRoot(cwd || mem.repoPath || process.cwd());
  mem.repoPath = repoPath;
  mem.updatedAt = Date.now();

  const localFile = getMemoryFilePath(repoPath);
  const fallbackFile = getFallbackMemoryFilePath(repoPath);

  if (process.env.AGENTBRIDGE_MEMORY_FALLBACK === '1') {
    writeAtomicJson(fallbackFile, mem);
    return;
  }

  try {
    writeAtomicJson(localFile, mem);
  } catch (localErr: any) {
    // If writing to local repository fails, fallback to ~/.agentbridge/memory/<repoHash>.json
    try {
      writeAtomicJson(fallbackFile, mem);
    } catch (fallbackErr: any) {
      throw new Error(`Failed to persist memory both locally ("${localFile}") and in fallback ("${fallbackFile}"): ${fallbackErr.message}`);
    }
  }
}

export function addRule(rule: string, cwd?: string): void {
  const trimmed = rule.trim();
  if (!trimmed) return;

  const mem = loadMemory(cwd);
  if (!Array.isArray(mem.rules)) {
    mem.rules = [];
  }

  if (!mem.rules.includes(trimmed)) {
    mem.rules.push(trimmed);
  }

  saveMemory(mem, cwd);
}

export function addDecision(topic: string, decision: string, agent?: string, cwd?: string): void {
  const t = topic.trim();
  const d = decision.trim();
  if (!t || !d) return;

  const mem = loadMemory(cwd);
  if (!Array.isArray(mem.decisions)) {
    mem.decisions = [];
  }

  const entry: MemoryDecision = {
    topic: t,
    decision: d,
    ...(agent && agent.trim() ? { agent: agent.trim() } : {}),
    createdAt: Date.now(),
  };

  mem.decisions.push(entry);
  saveMemory(mem, cwd);
}

export function setVariable(key: string, value: string, cwd?: string): void {
  const k = key.trim();
  if (!k) return;

  const mem = loadMemory(cwd);
  if (!mem.variables || typeof mem.variables !== 'object') {
    mem.variables = {};
  }

  mem.variables[k] = String(value);
  saveMemory(mem, cwd);
}

export function clearMemory(cwd?: string): void {
  const repoPath = path.resolve(cwd || process.cwd());
  const localFile = getMemoryFilePath(repoPath);
  const fallbackFile = getFallbackMemoryFilePath(repoPath);

  if (existsSync(localFile)) {
    try {
      unlinkSync(localFile);
    } catch {
      // ignore
    }
  }

  if (existsSync(fallbackFile)) {
    try {
      unlinkSync(fallbackFile);
    } catch {
      // ignore
    }
  }
}

export function formatMemoryForPrompt(cwd?: string): string | null {
  const mem = loadMemory(cwd);
  const hasRules = Array.isArray(mem.rules) && mem.rules.length > 0;
  const hasDecisions = Array.isArray(mem.decisions) && mem.decisions.length > 0;
  const hasVars = mem.variables && typeof mem.variables === 'object' && Object.keys(mem.variables).length > 0;

  if (!hasRules && !hasDecisions && !hasVars) {
    return null;
  }

  const lines: string[] = ['[PROJECT CONVENTIONS & MEMORY - PRESERVE THESE RULES]'];

  if (hasRules) {
    lines.push('Rules:');
    for (const r of mem.rules) {
      lines.push(`- ${r}`);
    }
  }

  if (hasDecisions) {
    lines.push('Key Decisions:');
    for (const d of mem.decisions) {
      const by = d.agent ? ` (agent: ${d.agent})` : '';
      lines.push(`- [${d.topic}] ${d.decision}${by}`);
    }
  }

  if (hasVars) {
    lines.push('Variables:');
    for (const [k, v] of Object.entries(mem.variables)) {
      lines.push(`- ${k}: ${v}`);
    }
  }

  return lines.join('\n');
}

// CLI helpers
export function cliMemoryAdd(rule: string, cwd?: string): void {
  addRule(rule, cwd);
}

export function cliMemoryDecision(topic: string, decision: string, agent?: string, cwd?: string): void {
  addDecision(topic, decision, agent, cwd);
}

export function cliMemoryList(cwd?: string): ProjectMemory {
  return loadMemory(cwd);
}

export function cliMemoryClear(cwd?: string): void {
  clearMemory(cwd);
}

export async function cmdMemory(
  _: string[],
  flags: Record<string, any>,
  io: { out?: (s: any) => void; err?: (s: any) => void } = {}
): Promise<void> {
  const out =
    io.out ||
    ((o: any) =>
      process.stdout.write(typeof o === 'string' ? o + (o.endsWith('\n') ? '' : '\n') : JSON.stringify(o, null, 2) + '\n'));
  const cwd = flags.cwd || process.cwd();
  const sub = _[0] || 'list';

  switch (sub) {
    case 'add': {
      const rule = flags.rule || _.slice(1).join(' ').trim();
      if (!rule) {
        throw new UsageError('Usage: ab memory add <rule>');
      }
      addRule(rule, cwd);
      if (flags.json) {
        out({ ok: true, rule });
      } else {
        out(`Added rule to project memory: "${rule}"`);
      }
      break;
    }
    case 'decision': {
      const topic = flags.topic || _[1];
      const decision = flags.decision || _.slice(2).join(' ').trim();
      const agent = flags.agent;
      if (!topic || !decision) {
        throw new UsageError('Usage: ab memory decision <topic> <decision> [--agent <agent>]');
      }
      addDecision(topic, decision, agent, cwd);
      if (flags.json) {
        out({ ok: true, topic, decision, agent });
      } else {
        out(`Recorded decision [${topic}]: "${decision}"${agent ? ` (${agent})` : ''}`);
      }
      break;
    }
    case 'list': {
      const mem = loadMemory(cwd);
      if (flags.json) {
        out(mem);
      } else {
        const hasRules = mem.rules && mem.rules.length > 0;
        const hasDecisions = mem.decisions && mem.decisions.length > 0;
        const hasVars = mem.variables && Object.keys(mem.variables).length > 0;
        if (!hasRules && !hasDecisions && !hasVars) {
          out(`Project memory is empty (${mem.repoPath}).`);
          return;
        }
        const lines: string[] = [
          `Project Memory: ${mem.repoPath}`,
          `Last updated: ${mem.updatedAt ? new Date(mem.updatedAt).toISOString() : 'never'}`,
        ];
        if (hasRules) {
          lines.push(`\nRules (${mem.rules.length}):`);
          mem.rules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
        }
        if (hasDecisions) {
          lines.push(`\nDecisions (${mem.decisions.length}):`);
          mem.decisions.forEach((d, i) => {
            const by = d.agent ? ` (${d.agent})` : '';
            lines.push(`  ${i + 1}. [${d.topic}] ${d.decision}${by}`);
          });
        }
        if (hasVars) {
          lines.push(`\nVariables:`);
          for (const [k, v] of Object.entries(mem.variables)) {
            lines.push(`  - ${k}: ${v}`);
          }
        }
        out(lines.join('\n'));
      }
      break;
    }
    case 'clear': {
      clearMemory(cwd);
      if (flags.json) {
        out({ ok: true, cleared: true });
      } else {
        out('Cleared project memory.');
      }
      break;
    }
    default:
      throw new UsageError(`Unknown memory action "${sub}". Expected add|decision|list|clear`);
  }
}
