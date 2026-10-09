// ACP (Agent Client Protocol) adapter.
// Implements the open Agent Client Protocol over stdio JSON-RPC 2.0.
// Allows connecting to any ACP-compliant agent server.

import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

export interface AcpAdapterOptions {
  name?: string;
  command?: string;
  args?: string[];
}

export function makeAcpAdapter(config: AcpAdapterOptions = {}): AgentAdapter {
  const name = config.name || 'acp';
  const command = config.command || 'acp-agent';
  const baseArgs = config.args || [];

  return {
    name,
    async models(): Promise<string[]> {
      return ['default'];
    },
    async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
      const o = validateOptions(opts);
      const t0 = Date.now();
      const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };

      const p = spawnProc(command, baseArgs, {
        cwd: o.cwd,
        env,
        keepStdinOpen: true,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        agent: name,
      });

      let reqId = 0;
      const sendRpc = (method: string, params: any = {}) => {
        const id = ++reqId;
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return id;
      };

      // 1. Handshake initialize
      sendRpc('initialize', { protocolVersion: '1.0', client: { name: 'agentbridge' } });

      let text = '', sessionId: string | undefined;
      let usage: any = { input: 0, output: 0, cost: null };
      let initialized = false;

      for await (const line of p.lines) {
        const j = parseJsonLine(line);
        if (!j) continue;
        yield ev.raw(j) as any;

        // In-flight server requests (e.g. approval)
        if (j.id != null && typeof j.method === 'string') {
          if (j.method === 'tool/requestApproval' || j.method === 'session/requestApproval' || j.method.endsWith('/requestApproval')) {
            const isApproved = o.permissions === 'full' || (o.permissions === 'edit' && !j.params?.dangerous);
            const decision = isApproved ? 'approved' : 'denied';
            p.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: j.id,
              result: { approved: isApproved, decision, status: decision },
            }) + '\n');
            yield ev.tool('acp:approval', j.params, { approved: isApproved }) as any;
            continue;
          }
        }

        if (j.id === 1 && !initialized) {
          initialized = true;
          // 2. Start turn / session
          sendRpc('session/prompt', {
            prompt: o.prompt,
            model: o.model,
            cwd: o.cwd,
            permissions: o.permissions,
            session: o.session,
          });
        } else if (j.method === 'session/created' || j.method === 'session/started') {
          sessionId = j.params?.sessionId || j.params?.id;
          if (sessionId && o.session?.mode !== 'ephemeral') yield ev.session(sessionId) as any;
        } else if (j.method === 'text/delta' || j.method === 'agent/message/delta') {
          const delta = j.params?.delta || j.params?.text || '';
          text += delta;
          yield ev.text(delta) as any;
        } else if (j.method === 'thinking/delta' || j.method === 'reasoning/delta') {
          yield ev.thinking(j.params?.delta || '') as any;
        } else if (j.method === 'tool/call') {
          yield ev.tool(j.params?.name || 'tool', j.params?.args) as any;
        } else if (j.method === 'turn/completed' || j.method === 'session/completed') {
          const u = j.params?.usage || {};
          usage = { input: u.inputTokens || 0, output: u.outputTokens || 0, cost: u.cost ?? null };
          yield ev.usage(usage.input, usage.output) as any;
          break;
        }
      }

      const r = await p.wait();
      return {
        text,
        sessionId,
        usage,
        exitCode: r.exitCode,
        model: o.model || 'default',
        durationMs: Date.now() - t0,
        timedOut: false,
      };
    },
  };
}

const defaultAcpAdapter: AgentAdapter = makeAcpAdapter();
export default defaultAcpAdapter;
