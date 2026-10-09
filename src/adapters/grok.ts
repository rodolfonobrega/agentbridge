// xAI Grok CLI adapter.
// Supports Grok agent CLI and ACP stdio mode.

import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const MODELS = ['grok-3', 'grok-3-mini', 'grok-2', 'grok-2-mini'];

const adapter: AgentAdapter = {
  name: 'grok',
  async models(): Promise<string[]> {
    return [...MODELS];
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.session?.mode === 'continue' || o.session?.mode === 'fork') {
      throw new AgentError('BAD_OPTION', `Grok adapter does not support session mode "${o.session.mode}"`, { agent: 'grok' });
    }
    if (o.offline) {
      throw new AgentError('BAD_OPTION', 'Offline mode is not supported by Grok CLI adapter', { agent: 'grok' });
    }
    if (o.images?.length) {
      throw new AgentError('BAD_OPTION', 'Multimodal images are not supported by Grok CLI adapter', { agent: 'grok' });
    }

    const t0 = Date.now();
    let effectivePrompt = o.prompt;
    if (o.permissions === 'read-only') {
      effectivePrompt = `[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\n${effectivePrompt}`;
    } else if (o.permissions === 'plan') {
      effectivePrompt = `[PLAN-ONLY MODE: Formulate a plan only; do NOT edit files]\n\n${effectivePrompt}`;
    }

    const args: string[] = ['-p', effectivePrompt, '--json'];

    if (o.model) args.push('-m', o.model);
    if (o.permissions === 'full') args.push('--permission-mode', 'bypassPermissions');
    if (o.cwd) args.push('--cwd', o.cwd);
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String));

    const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };
    const p = spawnProc('grok', args, {
      cwd: o.cwd,
      env,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      agent: 'grok',
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
      throw new AgentError('TIMEOUT', `Grok CLI timed out after ${o.timeoutMs}ms`, {
        agent: 'grok',
        partial: text.trim(),
        timedOut: true,
      });
    }
    if (r.aborted) {
      throw new AgentError('ABORTED', 'Grok CLI execution was aborted', {
        agent: 'grok',
        partial: text.trim(),
      });
    }

    if (r.exitCode !== 0 && !text) {
      const blob = `${errMsg || ''}\n${r.stderr}`.trim();
      if (/auth|login|api[-_]?key/i.test(blob)) {
        throw new AgentError('NOT_LOGGED_IN', `Grok CLI authentication missing: ${blob}`, { agent: 'grok' });
      }
      throw new AgentError('AGENT_FAILED', `Grok exited with code ${r.exitCode}: ${blob}`, {
        agent: 'grok',
        exitCode: r.exitCode,
        stderr: r.stderr,
      });
    }

    return {
      text: text.trim(),
      sessionId,
      usage,
      exitCode: r.exitCode,
      model: o.model || 'grok-3',
      durationMs: Date.now() - t0,
      timedOut: false,
    };
  },
};

export default adapter;
