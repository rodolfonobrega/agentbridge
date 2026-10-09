// Cursor CLI adapter.
// Drives the Cursor command line agent using existing local Cursor credentials.

import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const MODELS = ['claude-3.7-sonnet', 'claude-3.5-sonnet', 'claude-3-5-sonnet', 'gpt-4o', 'cursor-small'];

const adapter: AgentAdapter = {
  name: 'cursor',
  async models(): Promise<string[]> {
    return [...MODELS];
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.session?.mode === 'continue' || o.session?.mode === 'fork') {
      throw new AgentError('BAD_OPTION', `Cursor adapter does not support session mode "${o.session.mode}"`, { agent: 'cursor' });
    }
    if (o.offline) {
      throw new AgentError('BAD_OPTION', 'Offline mode is not supported by Cursor CLI adapter', { agent: 'cursor' });
    }
    if (o.images?.length) {
      throw new AgentError('BAD_OPTION', 'Multimodal images are not supported by Cursor CLI adapter', { agent: 'cursor' });
    }

    const t0 = Date.now();
    const args: string[] = ['agent', '--output-format', 'json'];

    if (o.model) args.push('--model', o.model);
    if (o.permissions === 'full') args.push('--auto-approve');
    if (o.cwd) args.push('--workspace', o.cwd);
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String));

    let effectivePrompt = o.prompt;
    if (o.permissions === 'read-only') {
      effectivePrompt = `[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\n${effectivePrompt}`;
    } else if (o.permissions === 'plan') {
      effectivePrompt = `[PLAN-ONLY MODE: Formulate a plan only; do NOT edit files]\n\n${effectivePrompt}`;
    }
    args.push('--prompt', effectivePrompt);

    const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };
    const p = spawnProc('cursor', args, {
      cwd: o.cwd,
      env,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      agent: 'cursor',
    });

    let text = '', sessionId: string | undefined;
    let usage: any = { input: 0, output: 0, cost: null };
    let errMsg: string | undefined;

    for await (const line of p.lines) {
      const j = parseJsonLine(line);
      if (j) {
        yield ev.raw(j) as any;
        if (j.type === 'text' || j.type === 'message') {
          const delta = j.delta || j.content || '';
          text += delta;
          yield ev.text(delta) as any;
        } else if (j.type === 'tool' || j.type === 'tool_call') {
          yield ev.tool(j.name || 'tool', j.params) as any;
        } else if (j.type === 'session') {
          sessionId = j.id;
          yield ev.session(j.id) as any;
        } else if (j.type === 'usage') {
          usage = { input: j.input || 0, output: j.output || 0, cost: j.cost ?? null };
          yield ev.usage(usage.input, usage.output) as any;
        } else if (j.type === 'error') {
          errMsg = j.message || errMsg;
          yield ev.error(j.message) as any;
        }
      } else {
        text += line + '\n';
        yield ev.text(line + '\n') as any;
      }
    }

    const r = await p.wait();
    if (r.timedOut) {
      throw new AgentError('TIMEOUT', `Cursor CLI timed out after ${o.timeoutMs}ms`, {
        agent: 'cursor',
        partial: text.trim(),
        timedOut: true,
      });
    }
    if (r.aborted) {
      throw new AgentError('ABORTED', 'Cursor CLI execution was aborted', {
        agent: 'cursor',
        partial: text.trim(),
      });
    }

    if (r.exitCode !== 0 && !text) {
      const blob = `${errMsg || ''}\n${r.stderr}`.trim();
      if (/auth|login|unauthorized/i.test(blob)) {
        throw new AgentError('NOT_LOGGED_IN', `Cursor CLI is not authenticated: ${blob}`, { agent: 'cursor' });
      }
      throw new AgentError('AGENT_FAILED', `Cursor exited with code ${r.exitCode}: ${blob}`, {
        agent: 'cursor',
        exitCode: r.exitCode,
        stderr: r.stderr,
      });
    }

    return {
      text: text.trim(),
      sessionId,
      usage,
      exitCode: r.exitCode,
      model: o.model || 'claude-3.7-sonnet',
      durationMs: Date.now() - t0,
      timedOut: false,
    };
  },
};

export default adapter;
