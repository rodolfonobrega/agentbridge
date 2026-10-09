// Google Gemini CLI adapter.
// Drives the installed `gemini` CLI using the local Google authentication.

import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];

const adapter: AgentAdapter = {
  name: 'gemini',
  async models(): Promise<string[]> {
    return [...MODELS];
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.session?.mode === 'continue' || o.session?.mode === 'fork') {
      throw new AgentError('BAD_OPTION', `Gemini adapter does not support session mode "${o.session.mode}"`, { agent: 'gemini' });
    }
    if (o.offline) {
      throw new AgentError('BAD_OPTION', 'Offline mode is not supported by Gemini CLI adapter', { agent: 'gemini' });
    }
    if (o.images?.length) {
      throw new AgentError('BAD_OPTION', 'Multimodal images are not supported via Gemini CLI arguments', { agent: 'gemini' });
    }

    const t0 = Date.now();
    const args: string[] = ['--output-format', 'json'];

    if (o.model) args.push('-m', o.model);
    if (o.permissions === 'full') args.push('--yolo');
    if (o.systemPrompt) args.push('--system', o.systemPrompt);
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
    const p = spawnProc('gemini', args, {
      cwd: o.cwd,
      env,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      agent: 'gemini',
    });

    let text = '', sessionId: string | undefined;
    let usage: any = { input: 0, output: 0, cost: null };
    let errMsg: string | undefined;

    for await (const line of p.lines) {
      const j = parseJsonLine(line);
      if (j) {
        yield ev.raw(j) as any;
        if (j.type === 'text') {
          text += j.content || j.delta || '';
          yield ev.text(j.content || j.delta || '') as any;
        } else if (j.type === 'usage') {
          usage = { input: j.inputTokens || 0, output: j.outputTokens || 0, cost: j.cost ?? null };
          yield ev.usage(usage.input, usage.output) as any;
        } else if (j.type === 'session') {
          sessionId = j.id;
          yield ev.session(j.id) as any;
        } else if (j.type === 'error') {
          errMsg = j.message || errMsg;
          yield ev.error(j.message) as any;
        }
      } else {
        // Plain text stream fallback
        text += line + '\n';
        yield ev.text(line + '\n') as any;
      }
    }

    const r = await p.wait();
    if (r.timedOut) {
      throw new AgentError('TIMEOUT', `Gemini CLI timed out after ${o.timeoutMs}ms`, {
        agent: 'gemini',
        partial: text.trim(),
        timedOut: true,
      });
    }
    if (r.aborted) {
      throw new AgentError('ABORTED', 'Gemini CLI execution was aborted', {
        agent: 'gemini',
        partial: text.trim(),
      });
    }

    if (r.exitCode !== 0 && !text) {
      const blob = `${errMsg || ''}\n${r.stderr}`.trim();
      if (/not logged in|login|auth/i.test(blob)) {
        throw new AgentError('NOT_LOGGED_IN', `Gemini CLI is not logged in: ${blob}`, { agent: 'gemini' });
      }
      throw new AgentError('AGENT_FAILED', `Gemini exited with code ${r.exitCode}: ${blob}`, {
        agent: 'gemini',
        exitCode: r.exitCode,
        stderr: r.stderr,
      });
    }

    return {
      text: text.trim(),
      sessionId,
      usage,
      exitCode: r.exitCode,
      model: o.model || 'gemini-2.5-flash',
      durationMs: Date.now() - t0,
      timedOut: false,
    };
  },
};

export default adapter;
