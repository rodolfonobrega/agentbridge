#!/usr/bin/env node
// npm run accept: runs every acceptance/*.test.mjs sequentially (so at most 2 real agents run concurrently at any
// moment, honoring the shared quota), with a per-file timeout, and writes a summary table + acceptance/RESULTS.md.
import { spawn } from 'node:child_process';
import { writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const PER_FILE_TIMEOUT_MS = Number(process.env.AGENTBRIDGE_ACCEPT_TIMEOUT_MS) || 20 * 60_000;

function listFiles() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (only.length) return only.map((f) => (f.endsWith('.mjs') ? f : `${f}.test.mjs`)).map((f) => path.join(DIR, path.basename(f)));
  return readdirSync(DIR).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(DIR, f));
}

function runFile(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-timeout=${PER_FILE_TIMEOUT_MS}`, file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '', killed = false;
    const to = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, PER_FILE_TIMEOUT_MS + 15_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    p.on('close', (code) => {
      clearTimeout(to);
      const text = out + errOut;
      // node --test-reporter=spec prints a summary as "ℹ tests N" / "ℹ pass N" / "ℹ fail N" (TAP's "# pass N" is the
      // fallback for older Node versions or a different reporter).
      const pass = (text.match(/^(?:#|ℹ) pass (\d+)/m) || [])[1];
      const fail = (text.match(/^(?:#|ℹ) fail (\d+)/m) || [])[1];
      const total = (text.match(/^(?:#|ℹ) tests (\d+)/m) || [])[1];
      resolve({
        file: path.basename(file), code, killed, durationMs: Date.now() - t0,
        pass: pass != null ? Number(pass) : null, fail: fail != null ? Number(fail) : null, total: total != null ? Number(total) : null,
        ok: code === 0 && !killed,
        tail: text.split('\n').slice(-60).join('\n'),
      });
    });
  });
}

function table(rows) {
  const head = '| file | result | tests | pass | fail | time |\n|---|---|---|---|---|---|';
  const line = (r) => `| ${r.file} | ${r.ok ? 'PASS' : r.killed ? 'TIMEOUT' : 'FAIL'} | ${r.total ?? '-'} | ${r.pass ?? '-'} | ${r.fail ?? '-'} | ${(r.durationMs / 1000).toFixed(1)}s |`;
  return [head, ...rows.map(line)].join('\n');
}

async function main() {
  const files = listFiles();
  if (!files.length) { console.error('no acceptance/*.test.mjs files found'); process.exit(1); }
  const rows = [];
  for (const f of files) {
    process.stderr.write(`\n=== running ${path.basename(f)} ===\n`);
    const r = await runFile(f);
    rows.push(r);
    process.stderr.write(`--- ${r.file}: ${r.ok ? 'PASS' : r.killed ? 'TIMEOUT' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s) ---\n`);
    if (!r.ok) process.stderr.write(r.tail + '\n');
  }
  const totals = rows.reduce((t, r) => ({ pass: t.pass + (r.pass || 0), fail: t.fail + (r.fail || 0), tests: t.tests + (r.total || 0) }), { pass: 0, fail: 0, tests: 0 });
  const allOk = rows.every((r) => r.ok);
  const summary = table(rows);
  console.log('\n' + summary + '\n');
  console.log(`TOTAL: tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} — ${allOk ? 'ALL GREEN' : 'FAILURES PRESENT'}`);

  const md = [
    '# Acceptance results', '', `Generated: ${new Date().toISOString()}`, '', summary, '',
    `**Total: tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} — ${allOk ? 'ALL GREEN' : 'FAILURES PRESENT'}**`, '',
    ...rows.filter((r) => !r.ok).flatMap((r) => [`## ${r.file} (failed)`, '```', r.tail, '```', '']),
  ].join('\n');
  writeFileSync(path.join(DIR, 'RESULTS.md'), md);
  process.exit(allOk ? 0 : 1);
}
main();
