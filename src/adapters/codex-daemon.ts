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

export class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: any) => void }> = [];
  private closed = false;
  /** Last failure stored by fail(), if any. */
  public error: any = null;

  push(value: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.resolve({ value: undefined as any, done: true });
    }
  }

  fail(err: any) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    // Failure must REACH consumers suspended inside next(): a pending wait resolves with
    // done:false would make the surrounding for-await loop look like a normal, successful end.
    while (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.reject(err);
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
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
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

export interface ActiveTurnContext {
  queue: AsyncQueue<AgentEvent>;
  turnId?: string;
  threadId?: string;
  permissions: string;
  text: string;
  usage: Usage;
  completed?: boolean;
  aborted?: boolean;
}

export class CodexAppServerDaemon {
  readonly cwd: string;
  readonly envExtra?: Record<string, string>;
  private p!: ProcessHandle;
  private nextReqId = 1;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private activeThreadId?: string;
  public activeTurn?: ActiveTurnContext;
  private isAlive = false;
  private hasSpawned = false;
  private initPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private turnQueue: Promise<void> = Promise.resolve();

  constructor(cwd: string, envExtra?: Record<string, string>) {
    this.cwd = path.resolve(cwd || process.cwd());
    this.envExtra = envExtra;
  }

  get spawned(): boolean {
    return this.hasSpawned;
  }

  get alive(): boolean {
    return this.isAlive && !this.p?.child?.killed && this.p?.child?.exitCode === null;
  }

  async ensureStarted(envExtra?: Record<string, string>, signal?: AbortSignal): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(this.envExtra || {}), ...(envExtra || {}) };
      if (!envExtra?.OPENAI_API_KEY && !this.envExtra?.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
      if (!envExtra?.CODEX_API_KEY && !this.envExtra?.CODEX_API_KEY) delete env.CODEX_API_KEY;

      const p = spawnProc('codex', ['app-server'], {
        cwd: this.cwd,
        env,
        keepStdinOpen: true,
        agent: 'codex',
      });
      this.p = p;
      this.isAlive = true;
      this.hasSpawned = true;

      // Start background reader loop
      this.listenBackground();

      // Handshake: initialize with 30s deadline and abort signal
      await this.sendRpc(
        'initialize',
        { clientInfo: { name: 'agentbridge', version: '0.3.5' } },
        { signal, timeoutMs: 30000 }
      );
      // Send notification initialized
      this.sendNotification('initialized');
      this.refreshIdleTimer();
    })();

    try {
      await this.initPromise;
    } catch (e) {
      this.isAlive = false;
      this.initPromise = undefined;
      if (this.p) {
        try {
          this.p.kill();
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  private sendRaw(obj: any) {
    if (!this.alive) throw new AgentError('AGENT_FAILED', 'Codex app-server daemon process is not running');
    this.p.stdin.write(JSON.stringify(obj) + '\n');
  }

  public sendRpc(
    method: string,
    params: any = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<any> {
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        reject(new AgentError('ABORTED', `Codex RPC "${method}" aborted`, { agent: 'codex' }));
      };
      const cleanup = () => {
        this.pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      if (opts.signal?.aborted) {
        return reject(new AgentError('ABORTED', `Codex RPC "${method}" aborted`, { agent: 'codex' }));
      }
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

      const timeoutMs = opts.timeoutMs ?? 30000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new AgentError('TIMEOUT', `Codex RPC "${method}" timed out after ${timeoutMs}ms`, { agent: 'codex', timedOut: true }));
        }, timeoutMs);
        timer.unref();
      }

      this.pendingRequests.set(id, {
        resolve: (val) => {
          cleanup();
          resolve(val);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  public sendResponse(id: number | string, result: any) {
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
      if (this.activeTurn && !this.activeTurn.completed) {
        this.activeTurn.queue.fail(err);
      }
    } finally {
      this.isAlive = false;
      for (const req of this.pendingRequests.values()) {
        req.reject(new AgentError('AGENT_FAILED', 'Codex app-server exited unexpectedly'));
      }
      this.pendingRequests.clear();
      if (this.activeTurn && !this.activeTurn.completed) {
        this.activeTurn.queue.fail(new AgentError('AGENT_FAILED', 'Codex app-server exited unexpectedly before turn completion'));
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

  /**
   * Whether a server notification belongs to the currently active turn.
   * Notifications from an orphaned turn (started by a run that was aborted while turn/start
   * was in flight) must not be routed to the next turn's queue. A notification that carries
   * no turn/thread ids at all (legacy shape) is always accepted.
   */
  private ownsNotification(turn: ActiveTurnContext, params: any, raw: any): boolean {
    const p = params || {};
    const rp = raw?.params || {};
    const turnId = p.turnId ?? p.turn?.id ?? rp.turnId ?? rp.turn?.id ?? raw?.turnId ?? raw?.turn?.id;
    const threadId = p.threadId ?? p.thread?.id ?? rp.threadId ?? rp.thread?.id ?? raw?.threadId ?? raw?.thread?.id;
    // turnCtx.turnId is only known after turn/start resolves: pre-turnId notifications are accepted.
    if (turnId != null && turn.turnId != null && turnId !== turn.turnId) return false;
    if (threadId != null && turn.threadId != null && threadId !== turn.threadId) return false;
    return true;
  }

  private handleServerNotification(method: string, params: any = {}, raw: any) {
    if (!this.activeTurn) return;
    if (!this.ownsNotification(this.activeTurn, params, raw)) return;

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

      const status = params?.turn?.status;
      const turnErr = params?.turn?.error;
      if (status === 'failed' || status === 'error' || turnErr) {
        const msg =
          turnErr?.message ||
          (typeof turnErr === 'string' ? turnErr : `Codex turn completed with error status: ${status}`);
        this.activeTurn.queue.fail(new AgentError('AGENT_FAILED', msg, { agent: 'codex' }));
        return;
      }

      this.activeTurn.completed = true;
      this.activeTurn.queue.push(ev.usage(this.activeTurn.usage.input, this.activeTurn.usage.output));
      this.activeTurn.queue.close();
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
    if (o.signal?.aborted) {
      throw new AgentError('ABORTED', 'Codex turn aborted before starting', { agent: 'codex' });
    }

    // A03: Serialize turns on this daemon instance to prevent activeTurn overwrite
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const waitPrevious = this.turnQueue;
    this.turnQueue = this.turnQueue.then(
      () => currentLock,
      () => currentLock
    );
    await waitPrevious;

    try {
      if (o.signal?.aborted) {
        throw new AgentError('ABORTED', 'Codex turn aborted before startup', { agent: 'codex' });
      }

      await this.ensureStarted(o.env, o.signal);

      if (o.signal?.aborted) {
        throw new AgentError('ABORTED', 'Codex turn aborted after startup', { agent: 'codex' });
      }

      const queue = new AsyncQueue<AgentEvent>();

      const turnCtx: ActiveTurnContext = {
        queue,
        permissions: o.permissions || 'full',
        text: '',
        usage: { input: 0, output: 0 },
      };
      this.activeTurn = turnCtx;

      // Abort signal handling
      let abortListener: (() => void) | undefined;
      if (o.signal) {
        abortListener = () => {
          turnCtx.aborted = true;
          if (turnCtx.turnId && turnCtx.threadId) {
            this.sendRpc(
              'turn/interrupt',
              { threadId: turnCtx.threadId, turnId: turnCtx.turnId },
              { timeoutMs: 5000 }
            ).catch(() => {});
          }
          queue.fail(new AgentError('ABORTED', 'Codex turn aborted', { agent: 'codex' }));
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
            this.sendRpc(
              'turn/interrupt',
              { threadId: turnCtx.threadId, turnId: turnCtx.turnId },
              { timeoutMs: 5000 }
            ).catch(() => {});
          }
          queue.fail(
            new AgentError('TIMEOUT', `Codex turn timed out after ${o.timeoutMs}ms`, {
              agent: 'codex',
              timedOut: true,
            })
          );
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
          const forkRes = await this.sendRpc('thread/fork', { threadId: o.session.id }, { signal: o.signal });
          threadId = forkRes?.thread?.id || forkRes?.threadId;
          this.activeThreadId = threadId;
          if (threadId) yield ev.session(threadId);
        } else if (!threadId || sessionMode === 'new' || sessionMode === 'ephemeral') {
          const sb = SANDBOX[o.permissions || 'full'] || 'workspace-write';
          const startRes = await this.sendRpc(
            'thread/start',
            {
              cwd: this.cwd,
              model: o.model || null,
              approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
              sandbox: sb,
              developerInstructions: o.systemPrompt || null,
              ephemeral: sessionMode === 'ephemeral',
            },
            { signal: o.signal }
          );
          threadId = startRes?.thread?.id || startRes?.threadId;
          this.activeThreadId = threadId;
          if (threadId && sessionMode !== 'ephemeral') {
            yield ev.session(threadId);
          }
        }

        turnCtx.threadId = threadId;

        if (o.signal?.aborted) {
          throw new AgentError('ABORTED', 'Codex turn aborted before turn start', { agent: 'codex' });
        }

        // A59: Support input text and multimodal images
        const turnInput: any[] = [{ type: 'text', text: o.prompt }];
        if (o.images?.length) {
          for (const img of o.images) {
            if (img.data && img.mediaType) {
              turnInput.push({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              });
            }
          }
        }

        // Start Turn
        const turnParams: any = {
          threadId,
          input: turnInput,
          approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
        };
        if (o.model) turnParams.model = o.model;
        if (o.effort) turnParams.effort = EFFORT[o.effort];
        if (o.jsonSchema) turnParams.outputSchema = o.jsonSchema;

        const turnRes = await this.sendRpc('turn/start', turnParams, { signal: o.signal });
        turnCtx.turnId = turnRes?.turn?.id || turnRes?.turnId;

        // Stream events from queue to caller
        for await (const event of queue) {
          yield event;
        }

        // A failed queue must surface as a failure, never as a normal end-of-stream success
        // (e.g. fail() raced the loop exit).
        if (queue.error) throw queue.error;

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
      }
    } finally {
      releaseLock();
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

function getDaemonPoolKey(cwd: string, env?: Record<string, string>): string {
  const resolvedCwd = path.resolve(cwd || process.cwd()).toLowerCase();
  const codexHome = env?.CODEX_HOME || process.env.CODEX_HOME || '';
  const apiKey = env?.OPENAI_API_KEY || env?.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
  const acct = env?.AGENTBRIDGE_ACCOUNT_NAME || '';
  return `${resolvedCwd}::${codexHome}::${acct}::${apiKey ? apiKey.slice(-8) : ''}`;
}

/** Global Daemon Pool indexed by resolved workspace path and effective account environment */
class DaemonPool {
  private daemons = new Map<string, CodexAppServerDaemon>();

  get(cwd: string, env?: Record<string, string>): CodexAppServerDaemon {
    const key = getDaemonPoolKey(cwd, env);
    let daemon = this.daemons.get(key);
    if (!daemon || (daemon.spawned && !daemon.alive)) {
      daemon = new CodexAppServerDaemon(cwd, env);
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
