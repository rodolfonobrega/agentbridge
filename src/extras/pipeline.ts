import { AgentError } from '../core/errors.js';
import { agents } from '../index.js';
import { createCheckpoint, rollbackCheckpoint } from './checkpoint.js';
import { PermissionLevel } from '../types/index.js';

export interface PipelineStep {
  id: string;
  agent: string;
  prompt: string;
  dependsOn?: string[];
  permissions?: PermissionLevel;
  model?: string;
  cwd?: string;
}

export interface PipelineConfig {
  name: string;
  steps: PipelineStep[];
}

export interface StepResult {
  id: string;
  agent: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface PipelineRunOptions {
  cwd?: string;
  checkpointEach?: boolean;
  stopOnError?: boolean;
  autoRollback?: boolean;
  signal?: AbortSignal;
}

export interface PipelineResult {
  name: string;
  success: boolean;
  durationMs: number;
  stepResults: Record<string, StepResult>;
  failedStepId?: string;
  rolledBack?: boolean;
}

/** Topologically sort steps into parallel execution waves */
export function buildExecutionWaves(steps: PipelineStep[]): PipelineStep[][] {
  const stepMap = new Map<string, PipelineStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const s of steps) {
    if (stepMap.has(s.id)) {
      throw new AgentError('BAD_OPTION', `Duplicate pipeline step id "${s.id}"`);
    }
    stepMap.set(s.id, s);
    inDegree.set(s.id, (s.dependsOn || []).length);
    dependents.set(s.id, []);
  }

  for (const s of steps) {
    for (const dep of s.dependsOn || []) {
      if (!stepMap.has(dep)) {
        throw new AgentError('BAD_OPTION', `Step "${s.id}" depends on unknown step "${dep}"`);
      }
      dependents.get(dep)!.push(s.id);
    }
  }

  const waves: PipelineStep[][] = [];
  let remainingCount = steps.length;
  const currentInDegree = new Map(inDegree);

  while (remainingCount > 0) {
    const currentWave: PipelineStep[] = [];
    for (const [id, deg] of currentInDegree.entries()) {
      if (deg === 0) {
        currentWave.push(stepMap.get(id)!);
      }
    }

    if (currentWave.length === 0) {
      throw new AgentError('BAD_OPTION', 'Cyclic dependency detected in pipeline steps');
    }

    waves.push(currentWave);
    for (const step of currentWave) {
      currentInDegree.delete(step.id);
      remainingCount--;
      for (const depId of dependents.get(step.id) || []) {
        if (currentInDegree.has(depId)) {
          currentInDegree.set(depId, currentInDegree.get(depId)! - 1);
        }
      }
    }
  }

  return waves;
}

/** Interpolate {{steps.<id>.output}} references in prompt string */
export function interpolatePrompt(prompt: string, stepResults: Record<string, StepResult>): string {
  return prompt.replace(/\{\{steps\.([a-zA-Z0-9_-]+)\.output\}\}/g, (_match, id) => {
    return stepResults[id]?.output ?? '';
  });
}

/** Run an entire pipeline of agents with DAG topological waves */
export async function runPipeline(
  pipeline: PipelineConfig,
  opts: PipelineRunOptions = {}
): Promise<PipelineResult> {
  const t0 = Date.now();
  const cwd = opts.cwd || process.cwd();
  const waves = buildExecutionWaves(pipeline.steps);
  const stepResults: Record<string, StepResult> = {};

  let initialCheckpointId: string | undefined;
  if (opts.autoRollback) {
    try {
      const cp = createCheckpoint(cwd, { message: `pre-pipeline-${pipeline.name}` });
      initialCheckpointId = cp.id;
    } catch {
      // not a git repo or checkpointing disabled
    }
  }

  let failedStepId: string | undefined;

  for (const wave of waves) {
    if (opts.signal?.aborted) {
      throw new AgentError('ABORTED', 'Pipeline run aborted');
    }

    // Run all steps in the current wave concurrently
    const wavePromises = wave.map(async (step) => {
      const stepT0 = Date.now();
      const resolvedPrompt = interpolatePrompt(step.prompt, stepResults);

      try {
        const adapter = await agents.get(step.agent);
        let output = '';
        const runGen = adapter.run({
          prompt: resolvedPrompt,
          model: step.model,
          permissions: step.permissions || 'full',
          cwd: step.cwd || cwd,
          signal: opts.signal,
        });

        for await (const event of runGen) {
          if (event.type === 'text') {
            output += event.delta || '';
          }
        }

        stepResults[step.id] = {
          id: step.id,
          agent: step.agent,
          output,
          durationMs: Date.now() - stepT0,
          success: true,
        };
      } catch (err: any) {
        stepResults[step.id] = {
          id: step.id,
          agent: step.agent,
          output: '',
          durationMs: Date.now() - stepT0,
          success: false,
          error: err?.message || String(err),
        };
        if (!failedStepId) {
          failedStepId = step.id;
        }
      }
    });

    await Promise.all(wavePromises);

    if (failedStepId && opts.stopOnError !== false) break;

    if (opts.checkpointEach) {
      try {
        createCheckpoint(cwd, { message: `checkpoint-wave-${wave.map((s) => s.id).join('-')}` });
      } catch {
        /* ignore */
      }
    }
  }

  const anyFailed = Object.values(stepResults).some((r: any) => !r.success);
  const success = !anyFailed;
  let rolledBack = false;

  if (!success && opts.autoRollback && initialCheckpointId) {
    try {
      rollbackCheckpoint(cwd, initialCheckpointId);
      rolledBack = true;
    } catch {
      /* ignore */
    }
  }

  return {
    name: pipeline.name,
    success,
    durationMs: Date.now() - t0,
    stepResults,
    failedStepId,
    rolledBack,
  };
}

export async function cmdPipeline(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const file = _[0];
  if (!file) {
    throw new AgentError('BAD_OPTION', 'Usage: ab pipeline <pipeline.json> [--checkpoint-each] [--auto-rollback]');
  }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const filePath = path.resolve(flags.cwd || process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    throw new AgentError('BAD_OPTION', `Pipeline file not found: ${filePath}`);
  }
  let config: PipelineConfig;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e: any) {
    throw new AgentError('BAD_OPTION', `invalid pipeline JSON in ${filePath}: ${e.message}`);
  }
  const res = await runPipeline(config, {
    cwd: flags.cwd,
    checkpointEach: flags['checkpoint-each'],
    autoRollback: flags['auto-rollback'],
  });
  if (flags.json) {
    io.out(res);
  } else {
    io.out(`Pipeline "${res.name}" ${res.success ? 'PASSED' : 'FAILED'} in ${res.durationMs}ms`);
    for (const [id, s] of Object.entries(res.stepResults)) {
      io.out(`  [${s.success ? 'OK' : 'FAIL'}] step "${id}" (${s.agent}): ${s.durationMs}ms`);
      if (s.error) io.out(`     Error: ${s.error}`);
    }
    if (res.rolledBack) {
      io.out('  Workspace rolled back to initial checkpoint.');
    }
  }
  if (!res.success) {
    process.exitCode = 1;
  }
}

