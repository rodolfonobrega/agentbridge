// Tiny argv parser: --k v, --k=v, -k v (short aliases), booleans, `--` terminator. Zero deps.
export const BOOL = new Set(['json', 'stream', 'worktree', 'all', 'once', 'live', 'keep', 'help', 'quiet', 'no-seed', 'no-models', 'allow-non-loopback', 'first', 'no-agents', 'no-skill', 'auto-approve', 'open']);
const SHORT = { m: 'model', e: 'effort', h: 'help', j: 'json', s: 'stream', w: 'worktree', t: 'timeout', C: 'cwd' };

export function parseArgs(argv) {
  const _ = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { _.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (/^-[A-Za-z]$/.test(a))) {
      let k, v; const eq = a.indexOf('=');
      if (a.startsWith('--')) { if (eq > 0) { k = a.slice(2, eq); v = a.slice(eq + 1); } else k = a.slice(2); } else k = SHORT[a.slice(1)] || a.slice(1);
      if (BOOL.has(k)) flags[k] = v === undefined ? true : !/^(0|false|no)$/i.test(v);
      else { if (v === undefined) { if (i + 1 >= argv.length) throw new UsageError(`flag --${k} needs a value`); v = argv[++i]; } flags[k] = v; }
    } else _.push(a);
  }
  return { _, flags };
}
export class UsageError extends Error { constructor(m) { super(m); this.code = 'USAGE'; } }

export const num = (flags, k, { min = 0, int = false } = {}) => {
  if (flags[k] == null) return undefined;
  const n = Number(flags[k]);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new UsageError(`--${k} must be a ${int ? 'integer' : 'number'} >= ${min}`);
  return n;
};

export async function readStdin() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
