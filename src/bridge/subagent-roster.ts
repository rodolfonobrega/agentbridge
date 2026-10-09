import { randomUUID } from 'node:crypto';
import { SubagentEntry } from './runs.js';

export type SubagentStatus = 'running' | 'completed' | 'failed';

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface SubagentNode {
  id: string;
  name: string;
  parentId?: string | null;
  parentToolCallId?: string | null;
  toolName?: string | null;
  task?: string;
  status: SubagentStatus;
  startedAt: number;
  completedAt?: number | null;
  tokens: TokenUsage;
  error?: string | null;
  result?: any;
  metadata?: Record<string, any>;
  children?: SubagentNode[];
}

export interface RegisterSubagentOptions {
  id?: string;
  taskId?: string;
  name?: string;
  parentId?: string | null;
  parentToolCallId?: string | null;
  toolName?: string | null;
  task?: string;
  status?: SubagentStatus;
  startedAt?: number;
  completedAt?: number | null;
  tokens?: TokenUsage;
  metadata?: Record<string, any>;
}

export interface UpdateStatusOptions {
  status: SubagentStatus;
  completedAt?: number | null;
  tokens?: TokenUsage;
  error?: string | null;
  result?: any;
  metadata?: Record<string, any>;
}

/**
 * Subagent Native Roster (inspired by Orca & T3 Code).
 * Tracks hierarchy of subagents (parent -> child -> grandchild) with unique task IDs,
 * status ('running', 'completed', 'failed'), timestamps, token metrics, and parent tool correlation.
 */
export class SubagentRoster {
  private nodes = new Map<string, SubagentNode>();
  private toolCallToId = new Map<string, string>();

  /**
   * Register a subagent in the roster.
   */
  registerSubagent(
    idOrOptions: string | RegisterSubagentOptions,
    maybeOptions?: Partial<RegisterSubagentOptions>
  ): SubagentNode {
    let opts: RegisterSubagentOptions;
    if (typeof idOrOptions === 'string') {
      opts = { ...(maybeOptions || {}), id: idOrOptions };
    } else {
      opts = idOrOptions;
    }

    const id = opts.id || opts.taskId || `task-${randomUUID().slice(0, 8)}`;
    const existing = this.nodes.get(id);

    const tokens: TokenUsage = {
      input: opts.tokens?.input ?? existing?.tokens?.input ?? 0,
      output: opts.tokens?.output ?? existing?.tokens?.output ?? 0,
      total:
        opts.tokens?.total ??
        (opts.tokens?.input !== undefined || opts.tokens?.output !== undefined
          ? (opts.tokens?.input ?? 0) + (opts.tokens?.output ?? 0)
          : existing?.tokens?.total ?? 0),
    };

    const node: SubagentNode = {
      id,
      name: opts.name || existing?.name || 'subagent',
      parentId: opts.parentId !== undefined ? opts.parentId : existing?.parentId || null,
      parentToolCallId:
        opts.parentToolCallId !== undefined
          ? opts.parentToolCallId
          : existing?.parentToolCallId || null,
      toolName: opts.toolName !== undefined ? opts.toolName : existing?.toolName || null,
      task: opts.task !== undefined ? opts.task : existing?.task || '',
      status: opts.status || existing?.status || 'running',
      startedAt: opts.startedAt || existing?.startedAt || Date.now(),
      completedAt:
        opts.completedAt !== undefined ? opts.completedAt : existing?.completedAt || null,
      tokens,
      error: existing?.error || null,
      result: existing?.result ?? null,
      metadata: { ...(existing?.metadata || {}), ...(opts.metadata || {}) },
    };

    this.nodes.set(id, node);
    if (node.parentToolCallId) {
      this.toolCallToId.set(node.parentToolCallId, id);
    }
    return node;
  }

  /**
   * Update status, completion timestamp, tokens, and error/result for a subagent.
   */
  updateStatus(
    id: string,
    statusOrOpts: SubagentStatus | UpdateStatusOptions
  ): SubagentNode | null {
    const node = this.nodes.get(id);
    if (!node) return null;

    let opts: UpdateStatusOptions;
    if (typeof statusOrOpts === 'string') {
      opts = { status: statusOrOpts };
    } else {
      opts = statusOrOpts;
    }

    node.status = opts.status;

    if (opts.tokens) {
      const inTok = opts.tokens.input ?? node.tokens.input ?? 0;
      const outTok = opts.tokens.output ?? node.tokens.output ?? 0;
      node.tokens = {
        input: inTok,
        output: outTok,
        total: opts.tokens.total ?? inTok + outTok,
      };
    }

    if (opts.error !== undefined) {
      node.error = opts.error;
    }

    if (opts.result !== undefined) {
      node.result = opts.result;
    }

    if (opts.metadata) {
      node.metadata = { ...(node.metadata || {}), ...opts.metadata };
    }

    if (node.status === 'completed' || node.status === 'failed') {
      node.completedAt = opts.completedAt || node.completedAt || Date.now();
    }

    return node;
  }

  /**
   * Get a single subagent by task ID.
   */
  getSubagent(id: string): SubagentNode | null {
    return this.nodes.get(id) || null;
  }

  /**
   * List all subagents currently in 'running' status.
   */
  listActive(): SubagentNode[] {
    const active: SubagentNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.status === 'running') {
        active.push(node);
      }
    }
    return active;
  }

  /**
   * List all subagents flatly.
   */
  listAll(): SubagentNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Build hierarchical subagent trees (parent -> child -> grandchild).
   * If rootId is provided, returns the subtree for that task.
   * If omitted, returns all root task trees.
   */
  getTree(rootId?: string): SubagentNode[] {
    const buildSubtree = (nodeId: string): SubagentNode | null => {
      const original = this.nodes.get(nodeId);
      if (!original) return null;

      const children: SubagentNode[] = [];
      for (const candidate of this.nodes.values()) {
        if (candidate.parentId === nodeId) {
          const childTree = buildSubtree(candidate.id);
          if (childTree) {
            children.push(childTree);
          }
        }
      }

      // Sort children by startedAt
      children.sort((a, b) => a.startedAt - b.startedAt);

      return {
        ...original,
        tokens: { ...original.tokens },
        children,
      };
    };

    if (rootId) {
      const tree = buildSubtree(rootId);
      return tree ? [tree] : [];
    }

    // Roots are nodes without parentId or whose parent is not registered in roster
    const roots: SubagentNode[] = [];
    for (const node of this.nodes.values()) {
      if (!node.parentId || !this.nodes.has(node.parentId)) {
        const rootTree = buildSubtree(node.id);
        if (rootTree) {
          roots.push(rootTree);
        }
      }
    }

    roots.sort((a, b) => a.startedAt - b.startedAt);
    return roots;
  }

  /**
   * Consumes agent events or tool calls:
   * - task_started
   * - ask_* tool calls
   * - dispatch_* tool calls
   * - subAgentActivity
   */
  consumeEvent(event: any): SubagentNode | null {
    if (!event || typeof event !== 'object') return null;

    const eventType = String(event.type || event.event || '');

    // 1. task_started event
    if (eventType === 'task_started') {
      const data = event.data || event;
      return this.registerSubagent({
        id: data.id || data.taskId,
        name: data.name || 'subagent',
        task: data.task || data.prompt || '',
        parentId: data.parentId || null,
        parentToolCallId: data.parentToolCallId || data.toolCallId || null,
        status: 'running',
        startedAt: data.startedAt || data.timestamp,
        tokens: data.tokens,
        metadata: data.metadata,
      });
    }

    // 2. task_completed / task_finished
    if (eventType === 'task_completed' || eventType === 'task_finished' || eventType === 'task_done') {
      const data = event.data || event;
      const id = data.id || data.taskId;
      if (!id) return null;
      return this.updateStatus(id, {
        status: 'completed',
        completedAt: data.completedAt || data.timestamp,
        tokens: data.tokens,
        result: data.result,
      });
    }

    // 3. task_failed / task_error
    if (eventType === 'task_failed' || eventType === 'task_error') {
      const data = event.data || event;
      const id = data.id || data.taskId;
      if (!id) return null;
      return this.updateStatus(id, {
        status: 'failed',
        completedAt: data.completedAt || data.timestamp,
        error: data.error || data.message || 'task failed',
      });
    }

    // 4. subAgentActivity (Orca / Antigravity format)
    if (eventType === 'subAgentActivity') {
      const subagentId = event.subagentId || event.id || event.taskId;
      const action = String(event.action || event.status || 'start').toLowerCase();

      if (action === 'start' || action === 'running') {
        return this.registerSubagent({
          id: subagentId,
          name: event.name || event.agentName || 'subagent',
          task: event.task || event.description || '',
          parentId: event.parentId || null,
          parentToolCallId: event.parentToolCallId || null,
          status: 'running',
          tokens: event.tokens,
        });
      }

      if (action === 'completed' || action === 'done' || action === 'finish') {
        if (!subagentId) return null;
        return this.updateStatus(subagentId, {
          status: 'completed',
          completedAt: event.completedAt,
          tokens: event.tokens,
          result: event.result,
        });
      }

      if (action === 'failed' || action === 'error') {
        if (!subagentId) return null;
        return this.updateStatus(subagentId, {
          status: 'failed',
          completedAt: event.completedAt,
          error: event.error || event.message,
        });
      }

      // Update in place
      if (subagentId && this.nodes.has(subagentId)) {
        return this.updateStatus(subagentId, {
          status: 'running',
          tokens: event.tokens,
          metadata: event.metadata,
        });
      }
    }

    // 5. Tool call: ask_* or dispatch_*
    const toolName = String(event.name || event.tool || '');
    if (
      eventType === 'tool' ||
      toolName.startsWith('ask_') ||
      toolName.startsWith('dispatch_') ||
      toolName.includes('agentbridge')
    ) {
      if (toolName.startsWith('ask_') || toolName.startsWith('dispatch_')) {
        return this.consumeToolCall(event);
      }
    }

    return null;
  }

  /**
   * Consume a tool call directly.
   */
  consumeToolCall(toolCall: any, parentId?: string): SubagentNode | null {
    if (!toolCall || typeof toolCall !== 'object') return null;

    const callId = String(toolCall.id || toolCall.callId || toolCall.toolCallId || '');
    const toolName = String(toolCall.name || toolCall.tool || '');

    // Check if we already registered this tool call
    let existingId = callId ? this.toolCallToId.get(callId) : undefined;
    if (!existingId && callId && this.nodes.has(callId)) {
      existingId = callId;
    }

    // Tool finished with output or error
    if (existingId) {
      if (toolCall.error) {
        return this.updateStatus(existingId, {
          status: 'failed',
          error: String(toolCall.error),
          tokens: toolCall.tokens,
        });
      }
      if (toolCall.output !== undefined || toolCall.result !== undefined) {
        return this.updateStatus(existingId, {
          status: 'completed',
          result: toolCall.output ?? toolCall.result,
          tokens: toolCall.tokens,
        });
      }
      return this.nodes.get(existingId) || null;
    }

    // Tool call starting: register new subagent
    const prompt =
      typeof toolCall.input === 'string'
        ? (() => {
            try {
              return JSON.parse(toolCall.input).prompt || toolCall.input;
            } catch {
              return toolCall.input;
            }
          })()
        : toolCall.input?.prompt || toolCall.prompt || '';

    const agentName = toolName.replace(/^(?:mcp__agentbridge__)?(?:ask_|dispatch_)/, '');

    const id = callId || `tool-${randomUUID().slice(0, 8)}`;
    const node = this.registerSubagent({
      id,
      name: agentName || toolName,
      toolName,
      parentToolCallId: callId || null,
      parentId: parentId || toolCall.parentId || null,
      task: prompt,
      status: toolCall.error ? 'failed' : toolCall.output !== undefined ? 'completed' : 'running',
      startedAt: toolCall.timestamp || Date.now(),
      tokens: toolCall.tokens,
    });

    if (callId) {
      this.toolCallToId.set(callId, id);
    }
    return node;
  }

  /**
   * Export to array of SubagentEntry objects compatible with runs.ts
   */
  toRunSubagents(): SubagentEntry[] {
    return Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      parentToolId: node.parentToolCallId,
      task: node.task,
      state:
        node.status === 'completed'
          ? 'done'
          : node.status === 'failed'
          ? 'failed'
          : 'running',
      startedAt: node.startedAt,
      endedAt: node.completedAt,
      tokens: {
        input: node.tokens.input,
        output: node.tokens.output,
      },
    }));
  }

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
    this.toolCallToId.clear();
  }
}
