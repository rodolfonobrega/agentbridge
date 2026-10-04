// Proxy configuration: aliases, payload rules, agent mode limits, account pool. Loaded from --config <file.json> and hot-reloaded
// with an atomic swap (requests already running keep the object they started with).
import { readFileSync, watch } from 'node:fs';

const PERMS = ['read-only', 'plan', 'edit', 'full'];
export const permRank = (p) => PERMS.indexOf(p);

export const DEFAULTS = Object.freeze({
  aliases: {},          // { "fast": "claude/haiku" }
  payload: [],          // [{ match: "claude/*", defaults: { effort: "medium" }, override: { effort: "low" } }]
  agentRoot: null,      // folder agent mode may work in (enables agent mode)
  maxPermission: 'edit',
  historyBudgetTokens: 0, // 0 = never truncate the conversation
  accounts: null,       // { claude: [{ name, env: {...} }], strategy: "round-robin" } (pool, see pool.mjs)
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + normalize a raw config object. Throws Error with a readable message. */
export function normalizeConfig(raw = {}) {
  if (!isObj(raw)) throw new Error('config must be a JSON object');
  const c = { ...DEFAULTS, ...raw };
  if (!isObj(c.aliases) || Object.values(c.aliases).some((v) => typeof v !== 'string')) throw new Error('config.aliases must map names to model strings');
  if (!Array.isArray(c.payload)) throw new Error('config.payload must be an array');
  for (const r of c.payload) if (!isObj(r) || typeof r.match !== 'string') throw new Error('config.payload entries need a string "match" glob');
  if (c.agentRoot != null && typeof c.agentRoot !== 'string') throw new Error('config.agentRoot must be a string');
  if (!PERMS.includes(c.maxPermission)) throw new Error(`config.maxPermission must be one of ${PERMS.join('|')}`);
  if (!(Number.isFinite(c.historyBudgetTokens) && c.historyBudgetTokens >= 0)) throw new Error('config.historyBudgetTokens must be a number >= 0');
  if (c.accounts != null && !isObj(c.accounts)) throw new Error('config.accounts must be an object');
  return c;
}

/** Glob with `*` wildcards (matches across `/`), case-insensitive. */
export function globMatch(glob, s) {
  const re = new RegExp('^' + glob.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(s);
}

/** Holder with an atomically swapped, immutable config snapshot. */
export function createConfig(initial = {}, { file } = {}) {
  let cur = Object.freeze(normalizeConfig(initial));
  let watcher, timer;
  const h = {
    get: () => cur,
    set(next) { cur = Object.freeze(normalizeConfig(next)); },
    /** Reload from `file`; on a parse/validation error the previous snapshot is kept and the error returned. */
    reload() {
      try { cur = Object.freeze(normalizeConfig({ ...initial, ...JSON.parse(readFileSync(file, 'utf8')) })); return null; } catch (e) { return e; }
    },
    watch(onError) {
      if (!file || watcher) return;
      try {
        watcher = watch(file, () => { clearTimeout(timer); timer = setTimeout(() => { const e = h.reload(); if (e && onError) onError(e); }, 150); });
        watcher.on('error', () => {}); watcher.unref?.();
      } catch { /* file watching is best-effort */ }
    },
    close() { clearTimeout(timer); watcher?.close(); watcher = undefined; },
  };
  if (file) { const e = h.reload(); if (e) throw new Error(`cannot load config ${file}: ${e.message}`); }
  return h;
}
