import { createCheckpoint, rollbackCheckpoint } from '../core/checkpoint.js';
import { spawnProc } from '../core/spawn.js';
import { agents, loadConfig } from '../index.js';
import { AgentError } from '../core/errors.js';
import type { AgentAdapter, RunOptions } from '../types/index.js';

export interface RepairOptions {
  testCommand: string | string[];
  agent?: string | AgentAdapter;
  prompt?: string;
  maxAttempts?: number; // default 3
  cwd?: string; // default process.cwd()
  autoRollback?: boolean; // default from config or true
  signal?: AbortSignal;
  model?: string;
  timeoutMs?: number;
}

export interface RepairAttempt {
  attempt: number;
  testPassed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  agentOutput?: string;
  durationMs: number;
  error?: string;
}

export interface RepairResult {
  success: boolean;
  attempts: number;
  initialCheckpoint?: string;
  finalCheckpoint?: string;
  rolledBack: boolean;
  testOutput: string;
  history: RepairAttempt[];
}

const MAX_OUTPUT_CAPTURE = 8192;

export function parseCommand(cmd: string | string[]): { cmd: string; args: string[] } {
  if (Array.isArray(cmd)) {
    return { cmd: cmd[0], args: cmd.slice(1).map(String) };
  }
  const str = String(cmd).trim();
  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(str)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(match[2]);
    else tokens.push(match[0]);
  }
  return { cmd: tokens[0] || '', args: tokens.slice(1) };
}

interface TestExecutionResult {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

async function runTestCommand(
  cmdInput: string | string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<TestExecutionResult> {
  const t0 = Date.now();
  const { cmd, args } = parseCommand(cmdInput);
  if (!cmd) {
    return {
      passed: false,
      exitCode: -1,
      stdout: '',
      stderr: 'Empty test command provided',
      durationMs: 0,
      error: 'Empty test command',
    };
  }

  try {
    const handle = spawnProc(cmd, args, { cwd, signal, timeoutMs });
    const MAX_LINES = 1000;
    const MAX_TOTAL_BYTES = 128 * 1024;
    const ringBuffer: string[] = [];
    let totalLinesSeen = 0;
    let bufferedBytes = 0;

    for await (const line of handle.lines) {
      totalLinesSeen++;
      bufferedBytes += line.length + 1;
      ringBuffer.push(line);
      while (ringBuffer.length > MAX_LINES || (bufferedBytes > MAX_TOTAL_BYTES && ringBuffer.length > 10)) {
        const removed = ringBuffer.shift();
        if (removed) bufferedBytes -= (removed.length + 1);
      }
    }
    const waitRes = await handle.wait();
    if (totalLinesSeen > ringBuffer.length) {
      const omitted = totalLinesSeen - ringBuffer.length;
      ringBuffer.unshift(`[... ${omitted} early lines truncated to preserve memory ...]`);
    }
    const stdout = ringBuffer.join('\n');
    const stderr = waitRes.stderr || '';
    const passed = waitRes.exitCode === 0;
    return {
      passed,
      exitCode: waitRes.exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - t0,
    };
  } catch (err: any) {
    return {
      passed: false,
      exitCode: -1,
      stdout: '',
      stderr: err.message || String(err),
      durationMs: Date.now() - t0,
      error: err.message,
    };
  }
}

function formatFailureOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const cleanOut = stdout.trim();
  const cleanErr = stderr.trim();
  if (cleanOut) {
    const tailOut = cleanOut.length > 4096 ? cleanOut.slice(-4096) : cleanOut;
    parts.push(`--- STDOUT ---\n${tailOut}`);
  }
  if (cleanErr) {
    const tailErr = cleanErr.length > 4096 ? cleanErr.slice(-4096) : cleanErr;
    parts.push(`--- STDERR ---\n${tailErr}`);
  }
  if (!parts.length) {
    parts.push('(Command failed with no output)');
  }
  return parts.join('\n\n').slice(-MAX_OUTPUT_CAPTURE);
}

function buildRepairPrompt(
  taskPrompt?: string,
  failureOutput?: string,
  attempt?: number,
  maxAttempts?: number
): string {
  const parts: string[] = [];
  if (taskPrompt) {
    parts.push(`Goal / Task instructions:\n${taskPrompt}`);
  }
  parts.push(
    `The test command failed${attempt ? ` (attempt ${attempt} of ${maxAttempts})` : ''} with the following output:\n\`\`\`\n${failureOutput}\n\`\`\``,
    'Please analyze the test failure and edit the files to fix the issue so the test passes.'
  );
  return parts.join('\n\n');
}

async function invokeAgent(
  agent: string | AgentAdapter,
  runOpts: RunOptions
): Promise<string> {
  const adapter = typeof agent === 'string' ? await agents.get(agent) : agent;
  const gen = adapter.run(runOpts);
  let output = '';
  while (true) {
    const next = await gen.next();
    if (next.done) {
      if (!output && next.value && typeof next.value.text === 'string') {
        output = next.value.text;
      }
      break;
    }
    const event = next.value;
    if (event.type === 'text') {
      output += event.delta || '';
    }
  }
  return output;
}

export async function autoRepair(opts: RepairOptions): Promise<RepairResult> {
  if (!opts.testCommand) {
    throw new AgentError('BAD_OPTION', 'testCommand is required for autoRepair');
  }

  const cwd = opts.cwd || process.cwd();
  const cfg = loadConfig(cwd);
  const effectiveAgent = opts.agent || cfg.defaultAgent;
  if (!effectiveAgent) {
    throw new AgentError('BAD_OPTION', 'agent is required for autoRepair (no agent passed and no defaultAgent configured)');
  }

  const maxAttempts = opts.maxAttempts ?? 3;
  const autoRollback = opts.autoRollback !== undefined ? opts.autoRollback : (cfg.autoRollback ?? true);
  const history: RepairAttempt[] = [];

  let initialCheckpoint: string | undefined;
  try {
    const cp = createCheckpoint(cwd, { message: 'pre-repair-initial' });
    initialCheckpoint = cp.id;
  } catch {
    // non-git workspace or git checkpointing unavailable
  }

  // Initial test run to check baseline
  const initialRun = await runTestCommand(opts.testCommand, cwd, opts.signal, opts.timeoutMs);
  const initialOutput = (initialRun.stdout + (initialRun.stderr ? '\n' + initialRun.stderr : '')).trim();

  if (initialRun.passed) {
    history.push({
      attempt: 0,
      testPassed: true,
      exitCode: initialRun.exitCode,
      stdout: initialRun.stdout,
      stderr: initialRun.stderr,
      durationMs: initialRun.durationMs,
    });
    return {
      success: true,
      attempts: 0,
      initialCheckpoint,
      finalCheckpoint: initialCheckpoint,
      rolledBack: false,
      testOutput: initialOutput,
      history,
    };
  }

  history.push({
    attempt: 0,
    testPassed: false,
    exitCode: initialRun.exitCode,
    stdout: initialRun.stdout,
    stderr: initialRun.stderr,
    durationMs: initialRun.durationMs,
    error: initialRun.error,
  });

  let lastRun = initialRun;
  let finalCheckpoint = initialCheckpoint;
  let rolledBack = false;
  let success = false;
  let attemptsDone = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsDone = attempt;
    if (opts.signal?.aborted) {
      throw new AgentError('ABORTED', 'Repair run aborted');
    }

    const failureOutput = formatFailureOutput(lastRun.stdout, lastRun.stderr);
    const repairPrompt = buildRepairPrompt(opts.prompt, failureOutput, attempt, maxAttempts);

    let agentOutput = '';
    const agentT0 = Date.now();
    try {
      agentOutput = await invokeAgent(effectiveAgent, {
        prompt: repairPrompt,
        cwd,
        permissions: 'edit',
        model: opts.model,
        signal: opts.signal,
      });
    } catch (err: any) {
      history.push({
        attempt,
        testPassed: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        agentOutput: '',
        durationMs: Date.now() - agentT0,
        error: `Agent execution failed: ${err.message}`,
      });
      continue;
    }

    // Re-run test command to check if fix worked
    const testRun = await runTestCommand(opts.testCommand, cwd, opts.signal, opts.timeoutMs);
    lastRun = testRun;

    history.push({
      attempt,
      testPassed: testRun.passed,
      exitCode: testRun.exitCode,
      stdout: testRun.stdout,
      stderr: testRun.stderr,
      agentOutput,
      durationMs: Date.now() - agentT0,
      error: testRun.error,
    });

    if (testRun.passed) {
      success = true;
      try {
        const cp = createCheckpoint(cwd, { message: `repair-success-attempt-${attempt}` });
        finalCheckpoint = cp.id;
      } catch {
        // checkpointing error ignored
      }
      break;
    }
  }

  if (!success && autoRollback && initialCheckpoint) {
    try {
      rollbackCheckpoint(cwd, initialCheckpoint);
      rolledBack = true;
    } catch {
      // rollback error ignored
    }
  }

  const finalOutput = (lastRun.stdout + (lastRun.stderr ? '\n' + lastRun.stderr : '')).trim();

  return {
    success,
    attempts: attemptsDone,
    initialCheckpoint,
    finalCheckpoint,
    rolledBack,
    testOutput: finalOutput,
    history,
  };
}

export async function cmdFix(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const agent = _[0];
  const testCmd = _[1];
  if (!agent || !testCmd) {
    throw new AgentError('BAD_OPTION', 'Usage: ab fix <agent> "<test-command>" [--prompt "..."] [--max-attempts 3]');
  }
  const res = await autoRepair({
    agent,
    testCommand: testCmd,
    prompt: flags.prompt,
    maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : 3,
    autoRollback: flags['auto-rollback'] !== false,
    cwd: flags.cwd,
  });
  if (flags.json) {
    io.out(res);
  } else {
    io.out(`TDD Auto-Repair ${res.success ? 'PASSED' : 'FAILED'} (attempts: ${res.attempts}, rolledBack: ${res.rolledBack})`);
    if (res.finalCheckpoint) io.out(`  Final checkpoint: ${res.finalCheckpoint}`);
    if (res.rolledBack) io.out('  Workspace rolled back to initial state.');
  }
  if (!res.success) process.exitCode = 1;
}

