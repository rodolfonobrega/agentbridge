// Seam test for opencode run(): a consumer breaking out of the event stream must still reach
// _run's finally (session-lock release, serve-process kill, live.delete) - otherwise the suspended
// generator leaks the `opencode serve` child tree and session locks ("session busy" on later runs).
// Drives the wrap generator against a stubbed _run; no opencode install or credentials needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import oc, { validateSchema } from '../dist/adapters/opencode.js';
import { validate } from '../dist/extras/schema.js';

test("run(): breaking out of the stream reaches _run's finally (cleanup)", async () => {
  const cleanup = { reached: false };
  const origRun = oc._run;
  oc._run = async function* () {
    try {
      yield { type: 'text', delta: 'one' };
    } finally {
      cleanup.reached = true;
    }
  };
  try {
    const g = oc.run({ prompt: 'x', cwd: process.cwd() });
    const n = await g.next();
    assert.ok(!n.done);
    assert.equal(n.value.delta, 'one');
    // Consumer breaks out of the stream (e.g. budget stop) -> generator .return()
    await g.return(undefined);
    assert.ok(cleanup.reached, "breaking the stream must drive _run's finally");
    // The generator must be finished for good afterwards
    const after = await g.next();
    assert.ok(after.done);
  } finally {
    oc._run = origRun;
  }
});

test("run(): throwing into a suspended stream reaches _run's finally (cleanup)", async () => {
  const cleanup = { reached: false };
  const origRun = oc._run;
  oc._run = async function* () {
    try {
      yield { type: 'text', delta: 'one' };
    } finally {
      cleanup.reached = true;
    }
  };
  try {
    const g = oc.run({ prompt: 'x', cwd: process.cwd() });
    await g.next();
    await assert.rejects(g.throw(new Error('consumer bailed')), /consumer bailed/);
    assert.ok(cleanup.reached, "throwing into the stream must drive _run's finally");
  } finally {
    oc._run = origRun;
  }
});

test('run(): normal completion still returns the inner result untouched', async () => {
  const origRun = oc._run;
  oc._run = async function* () {
    yield { type: 'text', delta: 'one' };
    return {
      text: 'final',
      sessionId: undefined,
      usage: { input: 1, output: 1 },
      exitCode: 0,
      model: 'default',
      durationMs: 1,
      timedOut: false,
    };
  };
  try {
    const g = oc.run({ prompt: 'x', cwd: process.cwd() });
    assert.deepEqual((await g.next()).value, { type: 'text', delta: 'one' });
    const fin = await g.next();
    assert.ok(fin.done);
    assert.equal(fin.value.text, 'final');
    // _run already exhausted: the cleanup finally in run() must not break the return value
    assert.equal(fin.value.exitCode, 0);
  } finally {
    oc._run = origRun;
  }
});

// opencode used to carry a private weaker copy of schema validation (no numeric bounds, string
// constraints, $ref or combinators): a jsonSchema run accepted {a:1} where pi/endpoint rejected it.
// It now delegates to the canonical shared validate — both seams must agree.
test('opencode jsonSchema validation matches the canonical shared validator (minimum enforced)', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'number', minimum: 5 } } };
  const shared = validate(schema, { a: 1 });
  assert.ok(shared.some((e) => e.includes('minimum')), 'shared validate rejects minimum violation');
  assert.deepEqual(validateSchema({ a: 1 }, schema), shared, 'opencode seam must agree with pi/endpoint path');
  assert.deepEqual(validateSchema({ a: 6 }, schema), []);
});