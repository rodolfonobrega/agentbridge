// One canonical invokeAgent for extras flows (repair, consensus): resolve an agent (by name or
// adapter instance) and drive its run generator to completion, accumulating text deltas.
// Keep this the only implementation — do not fork local copies in other modules.
import { agents } from '../index.js';
import type { AgentAdapter, RunOptions } from '../types/index.js';

/** Run an agent (by name or adapter instance) and return its text output: synchronous `text`
 *  deltas accumulate; when none were emitted, the final result's text field is used instead.
 *  Unwinds the generator on failure via return() so adapter cleanup still runs. */
export async function invokeAgent(agent: string | AgentAdapter, runOpts: RunOptions): Promise<string> {
  const adapter = typeof agent === 'string' ? await agents.get(agent) : agent;
  const gen = adapter.run(runOpts);
  let output = '';
  try {
    while (true) {
      const next = await gen.next();
      if (next.done) {
        if (!output && next.value && typeof next.value.text === 'string') {
          output = next.value.text;
        }
        break;
      }
      const event = next.value;
      if (event.type === 'text') {
        output += event.delta || '';
      }
    }
  } finally {
    // No-op once exhausted; on unwind it resumes the suspended adapter generator through its
    // finally clauses (child kill, lock release), matching drain()'s cleanup-on-error shape.
    await gen.return?.(undefined as any);
  }
  return output;
}