// feat-schema: agent-independent JSON Schema validation of outputs, with retry-on-invalid. Zero deps (draft-07 subset).
import { AgentError } from '../core/errors.mjs';
import { runBudgeted } from './budget.mjs';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : t === 'object' ? (v !== null && typeof v === 'object' && !Array.isArray(v)) : typeOf(v) === t);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Validate value against schema. Returns string[] of errors (empty = valid). Supports local $ref '#/...'. */
export function validate(schema, value, at = '$', root = schema) {
  const err = [];
  if (schema === true || schema == null) return err;
  if (schema === false) return [`${at}: no value allowed`];
  if (schema.$ref) {
    let t = root; for (const p of String(schema.$ref).replace(/^#\/?/, '').split('/').filter(Boolean)) t = t?.[p.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!t) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validate(t, value, at, root);
  }
  if (schema.type) {
    const ts = [].concat(schema.type);
    if (!ts.some((t) => isType(value, t))) return [`${at}: expected ${ts.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && !same(schema.const, value)) err.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((x) => same(x, value))) err.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  for (const s of schema.allOf || []) err.push(...validate(s, value, at, root));
  if (schema.anyOf && !schema.anyOf.some((s) => !validate(s, value, at, root).length)) err.push(`${at}: matches none of anyOf`);
  if (schema.oneOf) { const n = schema.oneOf.filter((s) => !validate(s, value, at, root).length).length; if (n !== 1) err.push(`${at}: matches ${n} of oneOf (need exactly 1)`); }
  if (schema.not && !validate(schema.not, value, at, root).length) err.push(`${at}: must not match "not" schema`);
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) err.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) err.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err.push(`${at}: does not match /${schema.pattern}/`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) err.push(`${at}: < minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) err.push(`${at}: > maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) err.push(`${at}: <= exclusiveMinimum`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) err.push(`${at}: >= exclusiveMaximum`);
    if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) err.push(`${at}: not a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) err.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) err.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) err.push(`${at}: items must be unique`);
    if (Array.isArray(schema.items)) schema.items.forEach((s, i) => { if (i < value.length) err.push(...validate(s, value[i], `${at}[${i}]`, root)); });
    else if (schema.items) value.forEach((x, i) => err.push(...validate(schema.items, x, `${at}[${i}]`, root)));
  }
  if (isType(value, 'object')) {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!(r in value)) err.push(`${at}: missing required property "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) err.push(...validate(props[k], v, `${at}.${k}`, root));
      else if (schema.additionalProperties === false) err.push(`${at}: unexpected property "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') err.push(...validate(schema.additionalProperties, v, `${at}.${k}`, root));
    }
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) err.push(`${at}: too few properties`);
  }
  return err;
}

/** Pull a JSON value out of model text: whole text, ```json fences, or the first balanced {...}/[...]. Returns {ok, value}. */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  const tries = [s];
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) tries.push(m[1].trim());
  for (let i = 0; i < s.length && tries.length < 8; i++) {
    const c = s[i]; if (c !== '{' && c !== '[') continue;
    const close = c === '{' ? '}' : ']'; let depth = 0, str = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (str) { if (esc) esc = false; else if (d === '\\') esc = true; else if (d === '"') str = false; continue; }
      if (d === '"') str = true; else if (d === c) depth++; else if (d === close && --depth === 0) { tries.push(s.slice(i, j + 1)); break; }
    }
  }
  for (const t of tries) { try { return { ok: true, value: JSON.parse(t) }; } catch { /* next */ } }
  return { ok: false, value: undefined };
}

const instruct = (schema) => `Respond with ONLY a single JSON value (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;

/**
 * Ask with schema enforcement, independent of what the agent supports natively (the schema is put in the prompt and checked here).
 * On invalid output, re-asks (fresh ephemeral call) with the errors, up to `retries` times.
 * o: {schema, retries=2, instructFirst=true, throwOnInvalid=false, runOne(agent, opts)=>Result, budget, gen, onEvent}
 * Returns the last Result plus `.json` and `.schema = {valid, value, attempts, errors, history}`.
 */
export async function askWithSchema(agent, runOpts, o = {}) {
  const { schema, retries = 2, instructFirst = true, throwOnInvalid = false } = o;
  if (!schema || typeof schema !== 'object') throw new AgentError('BAD_OPTION', 'schema must be an object');
  const runOne = o.runOne || ((a, p) => runBudgeted(a, p, o.budget || {}, { gen: o.gen, onEvent: o.onEvent }));
  const history = []; let prompt = instructFirst ? `${runOpts.prompt}\n\n${instruct(schema)}` : runOpts.prompt;
  let last, errors = [], value; const usage = { input: 0, output: 0, cost: 0 }; let hasCost = false;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    last = await runOne(agent, { ...runOpts, prompt, ...(attempt > 1 ? { session: { mode: 'ephemeral' } } : {}) });
    usage.input += last.usage?.input || 0; usage.output += last.usage?.output || 0;
    if (last.usage?.cost != null) { usage.cost += last.usage.cost; hasCost = true; }
    if (last.aborted) { errors = ['run aborted']; history.push({ attempt, valid: false, errors }); break; }
    const x = extractJson(last.text);
    errors = x.ok ? validate(schema, x.value) : ['output is not valid JSON'];
    history.push({ attempt, valid: !errors.length, errors, text: String(last.text).slice(0, 500) });
    if (!errors.length) { value = x.value; break; }
    prompt = `${runOpts.prompt}\n\nYour previous answer was rejected:\n${String(last.text).slice(0, 2000)}\n\nProblems:\n- ${errors.slice(0, 10).join('\n- ')}\n\n${instruct(schema)}`;
  }
  const valid = !errors.length;
  const res = { ...last, usage: hasCost ? usage : { input: usage.input, output: usage.output }, json: value, schema: { valid, value, attempts: history.length, errors, history } };
  if (!valid && throwOnInvalid) throw new AgentError('AGENT_FAILED', `output did not satisfy the schema after ${history.length} attempt(s): ${errors.join('; ')}`, { reason: 'SCHEMA_INVALID', result: res });
  return res;
}
