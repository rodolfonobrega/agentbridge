// Devin CLI adapter.
// Drives the Devin CLI agent using existing logins and configurations.

import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const MODELS = ['default', 'devin-default'];

const adapter: AgentAdapter = {
  name: 'devin',
  async models(): Promise<string[]> {
    return [...MODELS];
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.session?.mode === 'continue' || o.session?.mode === 'fork') {
      throw new AgentError('BAD_OPTION', `Devin adapter does not support session mode "${o.session.mode}"`, { agent: 'devin' });
    }
    if (o.offline) {
      throw new AgentError('BAD_OPTION', 'Offline mode is not supported by Devin CLI adapter', { agent: 'devin' });
    }
    if (o.images?.length) {
      throw new AgentError('BAD_OPTION', 'Multimodal images are not supported by Devin CLI adapter', { agent: 'devin' });
    }

    const t0 = Date.now();
    const args: string[] = ['run', '--json'];

    if (o.permissions === 'full') args.push('--permission-mode', 'bypass');
    if (o.cwd) args.push('--cwd', o.cwd);
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String));

    let effectivePrompt = o.prompt;
    if (o.permissions === 'read-only') {
      effectivePrompt = `[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\n${effectivePrompt}`;
    } else if (o.permissions === 'plan') {
      effectivePrompt = `[PLAN-ONLY MODE: Formulate a plan only; do NOT edit files]\n\n${effectivePrompt}`;
    }
    args.push('-p', effectivePrompt);

    const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };
    const p = spawnProc('devin', args, {
      cwd: o.cwd,
      env,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      agent: 'devin',
    });

    let text = '', sessionId: string | undefined;
    let usage: any = { input: 0, output: 0, cost: null };
    let errMsg: string | undefined;

    for await (const line of p.lines) {
      const j = parseJsonLine(line);
      if (j) {
        yield ev.raw(j) as any;
        if (j.type === 'text' || j.delta) {
          const delta = j.delta || j.text || '';
          text += delta;
          yield ev.text(delta) as any;
        } else if (j.type === 'usage') {
          usage = { input: j.input || 0, output: j.output || 0, cost: j.cost ?? null };
          yield ev.usage(usage.input, usage.output) as any;
        } else if (j.type === 'session') {
          sessionId = j.id;
          yield ev.session(j.id) as any;
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
      throw new AgentError('TIMEOUT', `Devin CLI timed out after ${o.timeoutMs}ms`, {
        agent: 'devin',
        partial: text.trim(),
        timedOut: true,
      });
    }
    if (r.aborted) {
      throw new AgentError('ABORTED', 'Devin CLI execution was aborted', {
        agent: 'devin',
        partial: text.trim(),
      });
    }

    if (r.exitCode !== 0 && !text) {
      const blob = `${errMsg || ''}\n${r.stderr}`.trim();
      if (/auth|login|token/i.test(blob)) {
        throw new AgentError('NOT_LOGGED_IN', `Devin CLI authentication missing: ${blob}`, { agent: 'devin' });
      }
      throw new AgentError('AGENT_FAILED', `Devin exited with code ${r.exitCode}: ${blob}`, {
        agent: 'devin',
        exitCode: r.exitCode,
        stderr: r.stderr,
      });
    }

    return {
      text: text.trim(),
      sessionId,
      usage,
      exitCode: r.exitCode,
      model: o.model || 'devin-default',
      durationMs: Date.now() - t0,
      timedOut: false,
    };
  },
};

export default adapter;
