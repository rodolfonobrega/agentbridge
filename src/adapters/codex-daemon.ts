import path from 'node:path';
import { spawnProc, ProcessHandle } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { AgentEvent, RunOptions, RunResult, Usage } from '../types/index.js';

export type ReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | { denied: { rejection: string } }
  | 'timed_out'
  | 'abort';

class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private error: any = null;

  push(value: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  fail(err: any) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) throw this.error;
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    if (this.closed) {
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

const SANDBOX: Record<string, string> = {
  'read-only': 'read-only',
  plan: 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

const EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

interface ActiveTurnContext {
  queue: AsyncQueue<AgentEvent>;
  turnId?: string;
  threadId?: string;
  permissions: string;
  text: string;
  usage: Usage;
  doneResolve?: (value: void) => void;
  doneReject?: (err: any) => void;
  aborted?: boolean;
}

export class CodexAppServerDaemon {
  readonly cwd: string;
  private p!: ProcessHandle;
  private nextReqId = 1;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private activeThreadId?: string;
  private activeTurn?: ActiveTurnContext;
  private isAlive = false;
  private initPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd || process.cwd());
  }

  get alive(): boolean {
    return this.isAlive && !this.p?.child?.killed && this.p?.child?.exitCode === null;
  }

  async ensureStarted(envExtra?: Record<string, string>): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(envExtra || {}) };
      if (!envExtra?.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
      if (!envExtra?.CODEX_API_KEY) delete env.CODEX_API_KEY;

      const p = spawnProc('codex', ['app-server'], {
        cwd: this.cwd,
        env,
        keepStdinOpen: true,
        agent: 'codex',
      });
      this.p = p;
      this.isAlive = true;

      // Start background reader loop
      this.listenBackground();

      // Handshake: initialize
      await this.sendRpc('initialize', {
        clientInfo: { name: 'agentbridge', version: '0.3.0' },
      });
      // Send notification initialized
      this.sendNotification('initialized');
      this.refreshIdleTimer();
    })();

    try {
      await this.initPromise;
    } catch (e) {
      this.isAlive = false;
      this.initPromise = undefined;
      throw e;
    }
  }

  private sendRaw(obj: any) {
    if (!this.alive) throw new AgentError('AGENT_FAILED', 'Codex app-server daemon process is not running');
    this.p.stdin.write(JSON.stringify(obj) + '\n');
  }

  private sendRpc(method: string, params: any = {}): Promise<any> {
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private sendResponse(id: number | string, result: any) {
    this.sendRaw({ jsonrpc: '2.0', id, result });
  }

  private sendNotification(method: string, params: any = {}) {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  private async listenBackground() {
    try {
      for await (const line of this.p.lines) {
        const j = parseJsonLine(line);
        if (!j) continue;
        this.refreshIdleTimer();

        // 1. In-flight Request from Server to Client (id + method)
        if (j.id != null && typeof j.method === 'string') {
          this.handleServerRequest(j.id, j.method, j.params);
          continue;
        }

        // 2. Response to Client Request (id + result / error)
        if (j.id != null && (j.result !== undefined || j.error !== undefined)) {
          const req = this.pendingRequests.get(Number(j.id));
          if (req) {
            this.pendingRequests.delete(Number(j.id));
            if (j.error) req.reject(new Error(j.error.message || JSON.stringify(j.error)));
            else req.resolve(j.result);
          }
          continue;
        }

        // 3. Server Notification (method without id)
        if (typeof j.method === 'string') {
          this.handleServerNotification(j.method, j.params, j);
        }
      }
    } catch (err) {
      if (this.activeTurn) {
        this.activeTurn.queue.fail(err);
        this.activeTurn.doneReject?.(err);
      }
    } finally {
      this.isAlive = false;
      for (const req of this.pendingRequests.values()) {
        req.reject(new AgentError('AGENT_FAILED', 'Codex app-server exited unexpectedly'));
      }
      this.pendingRequests.clear();
      if (this.activeTurn) {
        this.activeTurn.queue.close();
        this.activeTurn.doneResolve?.();
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: any = {}) {
    const perm = this.activeTurn?.permissions || 'full';
    let decision: ReviewDecision = 'approved';

    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = params?.command || '';
      if (perm === 'read-only' || perm === 'plan') {
        decision = { denied: { rejection: `${perm} permission: command execution denied` } };
      } else {
        decision = 'approved';
      }
      if (this.activeTurn) {
        this.activeTurn.queue.push(
          ev.tool('codex:approval:command', { command: cmd, permissions: perm }, { decision })
        );
      }
    } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      if (perm === 'read-only' || perm === 'plan') {
        decision = { denied: { rejection: `${perm} permission: file modification denied` } };
      } else {
        decision = 'approved';
      }
      if (this.activeTurn) {
        this.activeTurn.queue.push(
          ev.tool('codex:approval:fileChange', { files: params?.fileChanges || params?.path, permissions: perm }, { decision })
        );
      }
    } else if (method === 'item/permissions/requestApproval') {
      decision = perm === 'full' ? 'approved' : { denied: { rejection: 'Permission escalation denied' } };
    }

    this.sendResponse(id, { decision });
  }

  private handleServerNotification(method: string, params: any = {}, raw: any) {
    if (!this.activeTurn) return;

    this.activeTurn.queue.push(ev.raw(raw));

    if (method === 'item/agentMessage/delta') {
      const delta = params?.delta || '';
      this.activeTurn.text += delta;
      this.activeTurn.queue.push(ev.text(delta));
    } else if (method === 'item/reasoning/delta') {
      this.activeTurn.queue.push(ev.thinking(params?.delta || ''));
    } else if (method === 'item/completed' && params?.item) {
      const it = params.item;
      if (it.type === 'command_execution') {
        this.activeTurn.queue.push({
          ...ev.tool('shell', { command: it.command }, it.aggregated_output),
          id: it.id,
          exitCode: it.exit_code,
        } as any);
      } else if (it.type === 'file_change') {
        this.activeTurn.queue.push({
          ...ev.tool('file_change', { changes: it.changes }, it.status),
          id: it.id,
        } as any);
      }
    } else if (method === 'thread/tokenUsage/updated' && params?.tokenUsage) {
      const tu = params.tokenUsage;
      const src = tu.last || tu.total || tu;
      this.activeTurn.usage = {
        input: src.inputTokens || 0,
        output: src.outputTokens || 0,
        cachedInput: src.cachedInputTokens || 0,
        reasoning: src.reasoningOutputTokens || 0,
      };
    } else if (method === 'turn/completed') {
      const tu = params?.turn?.usage || params?.turn?.tokenUsage || params?.usage || {};
      const src = tu.last || tu.total || tu;
      this.activeTurn.usage = {
        input: src.inputTokens || this.activeTurn.usage.input,
        output: src.outputTokens || this.activeTurn.usage.output,
        cachedInput: src.cachedInputTokens || this.activeTurn.usage.cachedInput,
        reasoning: src.reasoningOutputTokens || this.activeTurn.usage.reasoning,
      };
      this.activeTurn.queue.push(ev.usage(this.activeTurn.usage.input, this.activeTurn.usage.output));
      this.activeTurn.queue.close();
      this.activeTurn.doneResolve?.();
    }
  }

  private refreshIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // 10 minutes of inactivity -> close daemon
    this.idleTimer = setTimeout(() => {
      if (!this.activeTurn) {
        this.close();
      }
    }, 10 * 60 * 1000);
    this.idleTimer.unref();
  }

  async *runTurn(o: RunOptions, t0: number): AsyncGenerator<AgentEvent, RunResult, void> {
    await this.ensureStarted(o.env);

    const queue = new AsyncQueue<AgentEvent>();
    let doneResolve!: (value: void) => void;
    let doneReject!: (err: any) => void;
    const donePromise = new Promise<void>((res, rej) => {
      doneResolve = res;
      doneReject = rej;
    });

    const turnCtx: ActiveTurnContext = {
      queue,
      permissions: o.permissions || 'full',
      text: '',
      usage: { input: 0, output: 0 },
      doneResolve,
      doneReject,
    };
    this.activeTurn = turnCtx;

    // Abort signal handling
    let abortListener: (() => void) | undefined;
    if (o.signal) {
      abortListener = () => {
        turnCtx.aborted = true;
        if (turnCtx.turnId && turnCtx.threadId) {
          this.sendRpc('turn/interrupt', { threadId: turnCtx.threadId, turnId: turnCtx.turnId }).catch(() => {});
        }
        queue.fail(new AgentError('ABORTED', 'Codex turn aborted', { agent: 'codex' }));
        doneReject(new AgentError('ABORTED', 'Codex turn aborted', { agent: 'codex' }));
      };
      if (o.signal.aborted) {
        abortListener();
      } else {
        o.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    // Timeout handling
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (o.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        if (turnCtx.turnId && turnCtx.threadId) {
          this.sendRpc('turn/interrupt', { threadId: turnCtx.threadId, turnId: turnCtx.turnId }).catch(() => {});
        }
        queue.fail(new AgentError('TIMEOUT', `Codex turn timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true }));
        doneReject(new AgentError('TIMEOUT', `Codex turn timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true }));
      }, o.timeoutMs);
      timeoutTimer.unref();
    }

    try {
      // Manage Thread: new / continue / fork / ephemeral
      const sessionMode = o.session?.mode || 'new';
      let threadId = this.activeThreadId;

      if (sessionMode === 'continue' && o.session?.id) {
        threadId = o.session.id;
        this.activeThreadId = threadId;
      } else if (sessionMode === 'fork' && o.session?.id) {
        const forkRes = await this.sendRpc('thread/fork', { threadId: o.session.id });
        threadId = forkRes?.thread?.id || forkRes?.threadId;
        this.activeThreadId = threadId;
        if (threadId) yield ev.session(threadId);
      } else if (!threadId || sessionMode === 'new' || sessionMode === 'ephemeral') {
        const sb = SANDBOX[o.permissions || 'full'] || 'workspace-write';
        const startRes = await this.sendRpc('thread/start', {
          cwd: this.cwd,
          model: o.model || null,
          approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
          sandbox: sb,
          developerInstructions: o.systemPrompt || null,
          ephemeral: sessionMode === 'ephemeral',
        });
        threadId = startRes?.thread?.id || startRes?.threadId;
        this.activeThreadId = threadId;
        if (threadId && sessionMode !== 'ephemeral') {
          yield ev.session(threadId);
        }
      }

      turnCtx.threadId = threadId;

      // Start Turn
      const turnParams: any = {
        threadId,
        input: [{ type: 'text', text: o.prompt }],
        approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
      };
      if (o.effort) turnParams.effort = EFFORT[o.effort];
      if (o.jsonSchema) turnParams.outputSchema = o.jsonSchema;

      const turnRes = await this.sendRpc('turn/start', turnParams);
      turnCtx.turnId = turnRes?.turn?.id || turnRes?.turnId;

      // Stream events from queue to caller
      for await (const event of queue) {
        yield event;
      }

      return {
        text: turnCtx.text,
        sessionId: sessionMode === 'ephemeral' ? undefined : threadId,
        usage: turnCtx.usage,
        exitCode: 0,
        model: o.model || 'default',
        durationMs: Date.now() - t0,
        timedOut: false,
        transport: 'app-server',
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (o.signal && abortListener) o.signal.removeEventListener('abort', abortListener);
      this.activeTurn = undefined;
      this.refreshIdleTimer();
    }
  }

  close() {
    this.isAlive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.p) {
      try {
        this.p.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Global Daemon Pool indexed by resolved workspace path */
class DaemonPool {
  private daemons = new Map<string, CodexAppServerDaemon>();

  get(cwd: string): CodexAppServerDaemon {
    const key = path.resolve(cwd || process.cwd()).toLowerCase();
    let daemon = this.daemons.get(key);
    if (!daemon || !daemon.alive) {
      daemon = new CodexAppServerDaemon(cwd);
      this.daemons.set(key, daemon);
    }
    return daemon;
  }

  shutdownAll() {
    for (const daemon of this.daemons.values()) {
      daemon.close();
    }
    this.daemons.clear();
  }
}

export const codexDaemonPool = new DaemonPool();

process.on('exit', () => {
  codexDaemonPool.shutdownAll();
});
