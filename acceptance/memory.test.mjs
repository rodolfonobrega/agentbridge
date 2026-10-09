import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadMemory,
  saveMemory,
  addRule,
  addDecision,
  setVariable,
  clearMemory,
  formatMemoryForPrompt,
  cmdMemory,
  cliMemoryAdd,
  cliMemoryDecision,
  cliMemoryList,
  cliMemoryClear,
} from '../dist/telemetry/memory.js';

test('loadMemory returns default empty memory for uninitialized directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-init-'));
  try {
    const mem = loadMemory(dir);
    assert.equal(path.resolve(mem.repoPath), path.resolve(dir));
    assert.deepEqual(mem.rules, []);
    assert.deepEqual(mem.decisions, []);
    assert.deepEqual(mem.variables, {});
    assert.equal(typeof mem.updatedAt, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveMemory and loadMemory round-trip with local storage', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-save-'));
  try {
    const mem = {
      repoPath: dir,
      updatedAt: Date.now(),
      rules: ['Always write clean TypeScript', 'Zero external dependencies'],
      decisions: [
        { topic: 'runtime', decision: 'Use Node.js 22 builtins', agent: 'claude', createdAt: Date.now() },
      ],
      variables: { PROJECT_PHASE: 'alpha' },
    };

    saveMemory(mem, dir);

    const memoryFile = path.join(dir, '.agentbridge', 'memory.json');
    assert.ok(existsSync(memoryFile), 'Local memory file must exist');

    const loaded = loadMemory(dir);
    assert.equal(loaded.rules.length, 2);
    assert.equal(loaded.rules[0], 'Always write clean TypeScript');
    assert.equal(loaded.decisions.length, 1);
    assert.equal(loaded.decisions[0].topic, 'runtime');
    assert.equal(loaded.decisions[0].agent, 'claude');
    assert.equal(loaded.variables.PROJECT_PHASE, 'alpha');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addRule appends rules and deduplicates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-rules-'));
  try {
    addRule('Rule 1: Strict TS', dir);
    addRule('Rule 2: PowerShell compatibility', dir);
    addRule('Rule 1: Strict TS', dir); // duplicate

    const mem = loadMemory(dir);
    assert.equal(mem.rules.length, 2);
    assert.equal(mem.rules[0], 'Rule 1: Strict TS');
    assert.equal(mem.rules[1], 'Rule 2: PowerShell compatibility');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addDecision logs architectural decisions with timestamp and agent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-dec-'));
  try {
    addDecision('db', 'Use SQLite embedded', 'codex', dir);
    addDecision('linter', 'Use tsc --noEmit', undefined, dir);

    const mem = loadMemory(dir);
    assert.equal(mem.decisions.length, 2);
    assert.equal(mem.decisions[0].topic, 'db');
    assert.equal(mem.decisions[0].decision, 'Use SQLite embedded');
    assert.equal(mem.decisions[0].agent, 'codex');
    assert.ok(mem.decisions[0].createdAt > 0);

    assert.equal(mem.decisions[1].topic, 'linter');
    assert.equal(mem.decisions[1].decision, 'Use tsc --noEmit');
    assert.equal(mem.decisions[1].agent, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatMemoryForPrompt formats structured conventions block or returns null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-prompt-'));
  try {
    // Empty directory returns null
    assert.equal(formatMemoryForPrompt(dir), null);

    // Add rules and decisions
    addRule('Never use && in powershell commands', dir);
    addDecision('architecture', 'Zero runtime dependencies', 'claude', dir);
    setVariable('STACK', 'typescript', dir);

    const promptBlock = formatMemoryForPrompt(dir);
    assert.ok(promptBlock);
    assert.ok(promptBlock.startsWith('[PROJECT CONVENTIONS & MEMORY - PRESERVE THESE RULES]'));
    assert.ok(promptBlock.includes('Never use && in powershell commands'));
    assert.ok(promptBlock.includes('[architecture] Zero runtime dependencies (agent: claude)'));
    assert.ok(promptBlock.includes('STACK: typescript'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage fallback persists to ~/.agentbridge/memory/<repoHash>.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-fallback-'));
  const prevFallback = process.env.AGENTBRIDGE_MEMORY_FALLBACK;
  process.env.AGENTBRIDGE_MEMORY_FALLBACK = '1';

  try {
    addRule('Fallback rule test', dir);
    const localFile = path.join(dir, '.agentbridge', 'memory.json');
    assert.equal(existsSync(localFile), false, 'Local file should not be created when fallback is forced');

    const loaded = loadMemory(dir);
    assert.equal(loaded.rules.length, 1);
    assert.equal(loaded.rules[0], 'Fallback rule test');
  } finally {
    if (prevFallback !== undefined) {
      process.env.AGENTBRIDGE_MEMORY_FALLBACK = prevFallback;
    } else {
      delete process.env.AGENTBRIDGE_MEMORY_FALLBACK;
    }
    clearMemory(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearMemory removes stored memory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-clear-'));
  try {
    addRule('Temporary rule', dir);
    assert.equal(loadMemory(dir).rules.length, 1);

    clearMemory(dir);
    const emptyMem = loadMemory(dir);
    assert.equal(emptyMem.rules.length, 0);
    assert.equal(formatMemoryForPrompt(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI helpers and cmdMemory operate correctly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-mem-cli-'));
  try {
    // 1. ab memory add
    cliMemoryAdd('CLI Rule 1', dir);
    let captured = '';
    const mockOut = (msg) => { captured += typeof msg === 'string' ? msg : JSON.stringify(msg); };

    await cmdMemory(['add', 'CLI Rule 2'], { cwd: dir }, { out: mockOut });
    assert.ok(captured.includes('CLI Rule 2'));

    // 2. ab memory decision
    cliMemoryDecision('api', 'REST over GraphQL', 'pi', dir);
    await cmdMemory(['decision', 'cache', 'Redis in-memory'], { cwd: dir, agent: 'agy' }, { out: mockOut });

    // 3. ab memory list (json)
    let jsonOutput = null;
    await cmdMemory(['list'], { cwd: dir, json: true }, { out: (data) => { jsonOutput = data; } });
    assert.ok(jsonOutput);
    assert.equal(jsonOutput.rules.length, 2);
    assert.equal(jsonOutput.decisions.length, 2);

    // 4. ab memory clear
    await cmdMemory(['clear'], { cwd: dir, json: true }, { out: mockOut });
    assert.equal(cliMemoryList(dir).rules.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
