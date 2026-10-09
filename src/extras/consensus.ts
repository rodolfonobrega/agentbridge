// Multi-Agent Review/Consensus & Ensemble for AgentBridge
import { createCheckpoint, diffCheckpoint } from '../core/checkpoint.js';
import { AgentError } from '../core/errors.js';
import { invokeAgent } from './invoke.js';
import type { AgentAdapter } from '../types/index.js';

// Canonical helper lives in invoke.ts; re-exported here to keep the module's public surface stable.
export { invokeAgent };

export interface ReviewVerdict {
  approved: boolean;
  verdict: 'APPROVED' | 'REJECTED';
  issues: string[];
  summary?: string;
  rawText: string;
}

export interface ReviewLoopOptions {
  implementer: string | AgentAdapter;
  reviewer: string | AgentAdapter;
  task: string;
  maxTurns?: number; // default 3
  cwd?: string;
  strict?: boolean; // default false
  checkpointPerTurn?: boolean; // default false
  signal?: AbortSignal;
  implementerModel?: string;
  reviewerModel?: string;
}

export interface TurnRecord {
  turn: number;
  implementerOutput: string;
  diff: string;
  reviewerOutput: string;
  verdict: ReviewVerdict;
  checkpointId?: string;
  durationMs: number;
}

export interface ReviewLoopResult {
  approved: boolean;
  turns: number;
  maxTurns: number;
  history: TurnRecord[];
  finalDiff: string;
  finalVerdict?: ReviewVerdict;
  initialCheckpoint?: string;
  finalCheckpoint?: string;
}

export interface EnsembleAgentConfig {
  agent: string | AgentAdapter;
  model?: string;
  name?: string;
}

export interface EnsembleOptions {
  agents: (string | EnsembleAgentConfig | AgentAdapter)[];
  task: string;
  judge?: string | AgentAdapter;
  judgeModel?: string;
  judgeMode?: 'select' | 'synthesize' | 'auto'; // default 'auto'
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentEnsembleOutput {
  agent: string;
  model?: string;
  output: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface EnsembleResult {
  outputs: AgentEnsembleOutput[];
  consensus: string;
  hasConsensus?: boolean;
  consensusMethod?: 'majority' | 'plurality' | 'judge' | 'tie' | 'none';
  selectedAgent?: string;
  judgeOutput?: string;
  durationMs: number;
}

export function parseReviewVerdict(text: string, strict = false): ReviewVerdict {
  const trimmed = text.trim();

  // 1. Attempt JSON block extraction or parsing
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, trimmed];
  const jsonCandidate = jsonMatch[1] || trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate);
    if (parsed && typeof parsed === 'object') {
      const v = String(parsed.verdict || parsed.status || '').toUpperCase();
      let approved: boolean;
      if (v === 'REJECTED' || v === 'CHANGES_REQUESTED') {
        approved = false;
      } else if (v === 'APPROVED') {
        approved = parsed.approved !== false;
      } else {
        approved = parsed.approved === true;
      }
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.map(String)
        : parsed.issues
        ? [String(parsed.issues)]
        : [];
      return {
        approved,
        verdict: approved ? 'APPROVED' : 'REJECTED',
        issues,
        summary: parsed.summary || parsed.critique || parsed.feedback || '',
        rawText: text,
      };
    }
  } catch {
    // Not valid JSON, fall through to text analysis
  }

  // 2. Text heuristics
  const upper = text.toUpperCase();
  const hasApproved = /\b(APPROVED|VERDICT:\s*APPROVED|STATUS:\s*APPROVED)\b/.test(upper);
  const hasRejected = /\b(REJECTED|VERDICT:\s*REJECTED|STATUS:\s*REJECTED|CHANGES_REQUESTED)\b/.test(upper);

  let approved = false;
  if (hasApproved && !hasRejected) {
    approved = true;
  } else if (hasRejected) {
    approved = false;
  } else if (!strict && /looks good|lgtm|no issues found|all tests pass/i.test(text)) {
    approved = true;
  }

  const issues: string[] = [];
  if (!approved) {
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*[-*•\d+.]\s+(.*)/);
      if (m && m[1].trim()) {
        issues.push(m[1].trim());
      }
    }
  }

  return {
    approved,
    verdict: approved ? 'APPROVED' : 'REJECTED',
    issues,
    summary: text.slice(0, 500),
    rawText: text,
  };
}

function buildReviewerPrompt(
  task: string,
  diff: string,
  implementerOutput: string,
  turn: number
): string {
  return [
    `# Task\n${task}`,
    `# Turn ${turn} Implementer Output\n${implementerOutput || '(No notes provided)'}`,
    `# Git Diff\n\`\`\`diff\n${diff || '(No file changes detected)'}\n\`\`\``,
    '# Review Instructions',
    'Review the implementation against the task requirements and diff.',
    'Provide your review verdict in structured JSON or Markdown with APPROVED or REJECTED.',
    'If REJECTED, list specific issues that must be addressed.',
    'Example JSON format:',
    '```json',
    '{',
    '  "verdict": "APPROVED",',
    '  "issues": [],',
    '  "summary": "Looks good"',
    '}',
    '```',
    'Or Markdown:',
    'VERDICT: APPROVED (or VERDICT: REJECTED)',
    '- Issue 1',
    '- Issue 2',
  ].join('\n\n');
}

function buildImplementerFeedbackPrompt(
  task: string,
  verdict: ReviewVerdict,
  turn: number
): string {
  const issuesList = verdict.issues.length
    ? verdict.issues.map((i) => `- ${i}`).join('\n')
    : verdict.summary || verdict.rawText;
  return [
    `# Task\n${task}`,
    `# Reviewer Feedback (Turn ${turn} - REJECTED)`,
    'The reviewer evaluated your implementation and requested revisions:',
    issuesList,
    '\nPlease revise the implementation to address all feedback and make any necessary changes.',
  ].join('\n\n');
}

export async function runReviewLoop(opts: ReviewLoopOptions): Promise<ReviewLoopResult> {
  if (!opts.implementer) throw new AgentError('BAD_OPTION', 'implementer is required');
  if (!opts.reviewer) throw new AgentError('BAD_OPTION', 'reviewer is required');
  if (!opts.task) throw new AgentError('BAD_OPTION', 'task is required');

  const cwd = opts.cwd || process.cwd();
  const maxTurns = opts.maxTurns ?? 3;
  const strict = opts.strict ?? false;
  const checkpointPerTurn = opts.checkpointPerTurn ?? false;
  const history: TurnRecord[] = [];

  let initialCheckpoint: string | undefined;
  try {
    const cp = createCheckpoint(cwd, { message: 'pre-review-loop-initial' });
    initialCheckpoint = cp.id;
  } catch {
    // non-git workspace or checkpointing unavailable
  }

  let finalCheckpoint = initialCheckpoint;
  let lastVerdict: ReviewVerdict | undefined;
  let lastDiff = '';

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) {
      throw new AgentError('ABORTED', 'Review loop aborted');
    }

    const turnT0 = Date.now();

    // 1. Determine implementer prompt
    const implementerPrompt =
      turn === 1
        ? opts.task
        : buildImplementerFeedbackPrompt(opts.task, lastVerdict!, turn - 1);

    // 2. Implementer executes with permissions 'edit'
    const implementerOutput = await invokeAgent(opts.implementer, {
      prompt: implementerPrompt,
      cwd,
      permissions: 'edit',
      model: opts.implementerModel,
      signal: opts.signal,
    });

    // 3. Capture git diff against initial checkpoint
    let diff = '';
    if (initialCheckpoint) {
      try {
        diff = diffCheckpoint(cwd, initialCheckpoint);
      } catch {
        diff = '';
      }
    }
    lastDiff = diff;

    // 4. Optional checkpoint per turn
    let turnCheckpointId: string | undefined;
    if (checkpointPerTurn) {
      try {
        const cp = createCheckpoint(cwd, { message: `review-loop-turn-${turn}` });
        turnCheckpointId = cp.id;
        finalCheckpoint = cp.id;
      } catch {
        // ignore
      }
    }

    // 5. Reviewer inspects diff with permissions 'read-only'
    const reviewerPrompt = buildReviewerPrompt(opts.task, diff, implementerOutput, turn);
    const reviewerOutput = await invokeAgent(opts.reviewer, {
      prompt: reviewerPrompt,
      cwd,
      permissions: 'read-only',
      model: opts.reviewerModel,
      signal: opts.signal,
    });

    // 6. Parse structured verdict
    const verdict = parseReviewVerdict(reviewerOutput, strict);
    lastVerdict = verdict;

    history.push({
      turn,
      implementerOutput,
      diff,
      reviewerOutput,
      verdict,
      checkpointId: turnCheckpointId,
      durationMs: Date.now() - turnT0,
    });

    if (verdict.approved) {
      if (!turnCheckpointId) {
        try {
          const cp = createCheckpoint(cwd, { message: `review-loop-approved-turn-${turn}` });
          finalCheckpoint = cp.id;
        } catch {
          // ignore
        }
      }
      return {
        approved: true,
        turns: turn,
        maxTurns,
        history,
        finalDiff: lastDiff,
        finalVerdict: verdict,
        initialCheckpoint,
        finalCheckpoint,
      };
    }
  }

  return {
    approved: false,
    turns: maxTurns,
    maxTurns,
    history,
    finalDiff: lastDiff,
    finalVerdict: lastVerdict,
    initialCheckpoint,
    finalCheckpoint,
  };
}

function buildJudgePrompt(
  task: string,
  outputs: AgentEnsembleOutput[],
  mode: 'select' | 'synthesize' | 'auto'
): string {
  const parts: string[] = [
    `# Original Task\n${task}`,
    `# Agent Responses (${outputs.length} agents evaluated):\n`,
  ];

  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    parts.push(
      `## Candidate ${i + 1}: ${o.agent}${o.model ? ` (model: ${o.model})` : ''}`,
      o.success ? o.output : `[Failed: ${o.error || 'Unknown error'}]`
    );
  }

  if (mode === 'select') {
    parts.push(
      '# Judge Instructions',
      'Compare all candidate responses and select the single best answer.',
      'Explicitly state: "Selected Agent: <agent name>" on a separate line, followed by your rationale and the chosen answer.'
    );
  } else if (mode === 'synthesize') {
    parts.push(
      '# Judge Instructions',
      'Synthesize the key insights from all valid candidate responses into a unified, highest-quality consensus response.'
    );
  } else {
    parts.push(
      '# Judge Instructions',
      'Evaluate all candidate responses. If one candidate is clearly superior, select it and state "Selected Agent: <agent name>".',
      'Otherwise, synthesize the best insights from the responses into a single comprehensive consensus answer.'
    );
  }

  return parts.join('\n\n');
}

export async function runEnsemble(opts: EnsembleOptions): Promise<EnsembleResult> {
  if (!opts.agents || !opts.agents.length) {
    throw new AgentError('BAD_OPTION', 'Ensemble requires at least one agent');
  }
  if (!opts.task) {
    throw new AgentError('BAD_OPTION', 'task is required for ensemble');
  }

  const t0 = Date.now();
  const configs: EnsembleAgentConfig[] = opts.agents.map((a, i) => {
    if (typeof a === 'string') {
      return { agent: a, name: a };
    }
    if (typeof a === 'object' && a !== null) {
      if ('run' in a && typeof (a as any).run === 'function') {
        return { agent: a as AgentAdapter, name: (a as any).name || `agent-${i + 1}` };
      }
      const cfg = a as EnsembleAgentConfig;
      return {
        agent: cfg.agent,
        model: cfg.model,
        name: cfg.name || (typeof cfg.agent === 'string' ? cfg.agent : (cfg.agent as any).name) || `agent-${i + 1}`,
      };
    }
    return { agent: String(a), name: `agent-${i + 1}` };
  });

  // Run all agents in parallel
  const outputs: AgentEnsembleOutput[] = await Promise.all(
    configs.map(async (cfg) => {
      const start = Date.now();
      try {
        const text = await invokeAgent(cfg.agent, {
          prompt: opts.task,
          cwd: opts.cwd,
          model: cfg.model,
          permissions: 'read-only',
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        return {
          agent: cfg.name!,
          model: cfg.model,
          output: text,
          success: true,
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        return {
          agent: cfg.name!,
          model: cfg.model,
          output: '',
          success: false,
          error: err.message || String(err),
          durationMs: Date.now() - start,
        };
      }
    })
  );

  // If a judge is provided, let judge evaluate / synthesize
  if (opts.judge) {
    const judgePrompt = buildJudgePrompt(opts.task, outputs, opts.judgeMode || 'auto');
    const judgeOutput = await invokeAgent(opts.judge, {
      prompt: judgePrompt,
      cwd: opts.cwd,
      model: opts.judgeModel,
      permissions: 'read-only',
      signal: opts.signal,
    });

    let selectedAgent: string | undefined;
    const match = judgeOutput.match(/Selected Agent:\s*([^\r\n]+)/i);
    if (match) {
      const cand = match[1].trim();
      const found = configs.find((c) => c.name?.toLowerCase() === cand.toLowerCase());
      selectedAgent = found ? found.name : cand;
    }

    return {
      outputs,
      consensus: judgeOutput,
      hasConsensus: true,
      consensusMethod: 'judge',
      selectedAgent,
      judgeOutput,
      durationMs: Date.now() - t0,
    };
  }

  // Without a judge: consensus by voting or first successful answer
  const successful = outputs.filter((o) => o.success && o.output.trim());
  if (!successful.length) {
    return {
      outputs,
      consensus: '',
      hasConsensus: false,
      consensusMethod: 'none',
      durationMs: Date.now() - t0,
    };
  }

  // Check for majority / plural exact match
  const counts = new Map<string, { count: number; output: string; agent: string }>();
  for (const s of successful) {
    const key = s.output.trim();
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { count: 1, output: s.output, agent: s.agent });
    }
  }

  let best = successful[0];
  let highestCount = 0;
  for (const item of counts.values()) {
    if (item.count > highestCount) {
      highestCount = item.count;
      best = { agent: item.agent, output: item.output, success: true, durationMs: 0 };
    }
  }

  const hasConsensus = highestCount > 1 || successful.length === 1;
  const isMajority = highestCount > successful.length / 2;
  const consensusMethod = !hasConsensus ? 'tie' : isMajority ? 'majority' : 'plurality';

  return {
    outputs,
    consensus: hasConsensus ? best.output : '',
    hasConsensus,
    consensusMethod,
    selectedAgent: hasConsensus ? best.agent : undefined,
    durationMs: Date.now() - t0,
  };
}

export async function cmdReview(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const implementer = _[0];
  const reviewer = _[1];
  const task = _.slice(2).join(' ') || flags.prompt || flags.task;
  if (!implementer || !reviewer || !task) {
    throw new AgentError('BAD_OPTION', 'Usage: ab review <implementer> <reviewer> "<task>" [--max-turns 3] [--strict]');
  }
  const res = await runReviewLoop({
    implementer,
    reviewer,
    task,
    maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : 3,
    strict: Boolean(flags.strict),
    cwd: flags.cwd,
  });
  if (flags.json) {
    io.out(res);
  } else {
    io.out(`Review Loop ${res.approved ? 'APPROVED' : 'REJECTED'} after ${res.turns} turn(s)`);
    if (res.finalVerdict) {
      if (res.finalVerdict.summary) io.out(`Summary: ${res.finalVerdict.summary}`);
      if (res.finalVerdict.issues.length) {
        io.out('Issues:');
        for (const iss of res.finalVerdict.issues) io.out(`  - ${iss}`);
      }
    }
  }
  if (!res.approved) process.exitCode = 1;
}

export async function cmdEnsemble(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const task = _[0];
  const agentList = _.slice(1);
  if (!task || !agentList.length) {
    throw new AgentError('BAD_OPTION', 'Usage: ab ensemble "<task>" <agent1> <agent2> ... [--judge <judge>]');
  }
  const res = await runEnsemble({
    task,
    agents: agentList,
    judge: flags.judge,
    cwd: flags.cwd,
  });
  if (flags.json) {
    io.out(res);
  } else {
    io.out(`Ensemble finished in ${res.durationMs}ms:`);
    if (res.selectedAgent) io.out(`Selected Agent: ${res.selectedAgent}`);
    io.out(`Consensus:\n${res.consensus}`);
  }
}

