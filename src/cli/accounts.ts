import { spawnSync } from 'node:child_process';
import {
  listAccounts,
  addAccount,
  removeAccount,
  setActiveAccount,
  getActiveAccount,
  getAccountEnv,
  AccountRecord,
} from '../core/accounts.js';
import { UsageError } from './args.js';
import { getProactiveQuotaStatus, formatQuotaStatus } from '../quota/proactive.js';

export async function cmdAccount(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err: (msg: any) => void }
): Promise<void> {
  const { out, err } = io;
  const sub = _[0] || 'list';

  if (sub === 'list') {
    const agent = _[1];
    const accounts = listAccounts(agent, flags.baseDir);
    if (flags.json) {
      out(accounts);
      return;
    }
    if (!accounts.length) {
      out(agent ? `No accounts registered for agent "${agent}".` : 'No accounts registered. Use "ab account add <agent> <name>" to add one.');
      return;
    }

    out('Registered Agent Accounts:\n');
    out(
      `${'AGENT'.padEnd(10)} ${'ACCOUNT'.padEnd(14)} ${'ACTIVE'.padEnd(8)} ${'EMAIL / PLAN'.padEnd(26)} PROFILE DIRECTORY`
    );
    out('-'.repeat(85));
    for (const acc of accounts) {
      const activeRec = getActiveAccount(acc.agent, flags.baseDir);
      const isActive = activeRec?.name.toLowerCase() === acc.name.toLowerCase() ? '*' : '';
      const detail = [acc.email, acc.plan].filter(Boolean).join(' / ') || '-';
      out(
        `${acc.agent.padEnd(10)} ${acc.name.padEnd(14)} ${isActive.padEnd(8)} ${detail.padEnd(26)} ${acc.profileDir}`
      );
    }
    return;
  }

  if (sub === 'add') {
    const agent = _[1];
    const name = _[2];
    if (!agent || !name) {
      throw new UsageError('Usage: ab account add <agent> <name> [--copy-current] [--login]');
    }

    const copyCurrent = Boolean(flags['copy-current'] || flags.copy);
    const rec = addAccount(agent, name, {
      copyCurrent,
      share: flags['no-share'] !== true,
      baseDir: flags.baseDir,
    });

    out(`Added account "${rec.name}" for "${rec.agent}".`);
    out(`Profile directory: ${rec.profileDir}`);
    if (!copyCurrent && flags['no-share'] !== true) {
      out('Skills, prompts, plugins and MCP servers are shared from your main setup (credentials and sessions stay separate). Use --no-share to start empty.');
    }

    if (flags.login) {
      out(`\nLaunching interactive login for "${agent}" with profile "${name}"...`);
      const env = { ...process.env, ...getAccountEnv(agent, name, flags.baseDir) };
      let cmd = agent;
      let args: string[] = [];

      if (agent === 'claude') {
        cmd = 'claude';
        args = ['auth', 'login'];
      } else if (agent === 'codex') {
        cmd = 'codex';
        args = ['login'];
      } else if (agent === 'pi') {
        cmd = 'pi';
        args = ['/login'];
      } else if (agent === 'opencode') {
        cmd = 'opencode';
        args = ['auth', 'login'];
      }

      const res = spawnSync(cmd, args, { stdio: 'inherit', env });
      if (res.status === 0) {
        out(`Login completed successfully for "${name}".`);
      } else {
        err(`Login process exited with code ${res.status}.`);
      }
    }
    return;
  }

  if (sub === 'use' || sub === 'switch') {
    const agent = _[1];
    const name = _[2];
    if (!agent || !name) {
      throw new UsageError(`Usage: ab account ${sub} <agent> <name>`);
    }
    setActiveAccount(agent, name, flags.baseDir);
    out(`Active account for agent "${agent}" set to "${name}".`);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const agent = _[1];
    const name = _[2];
    if (!agent || !name) {
      throw new UsageError('Usage: ab account remove <agent> <name> [--purge]');
    }
    const purged = Boolean(flags.purge || flags['delete-dir']);
    const ok = removeAccount(agent, name, {
      deleteProfileDir: purged,
      baseDir: flags.baseDir,
    });
    if (!ok) {
      throw new UsageError(`Account "${name}" for agent "${agent}" was not found.`);
    }
    out(`Removed account "${name}" from agent "${agent}"${purged ? ' and purged profile directory' : ''}.`);
    return;
  }

  if (sub === 'quota') {
    const agent = _[1];
    const name = _[2];
    const accounts = listAccounts(agent, flags.baseDir).filter((a) => !name || a.name.toLowerCase() === name.toLowerCase());
    if (!accounts.length) {
      out('No matching accounts found.');
      return;
    }

    const results: any[] = [];
    for (const acc of accounts) {
      const accEnv = getAccountEnv(acc.agent, acc.name, flags.baseDir);
      const q = await getProactiveQuotaStatus(acc.agent, undefined, {
        env: accEnv,
        profileDir: acc.profileDir,
      });
      results.push({
        agent: acc.agent,
        account: acc.name,
        profile: acc.profileDir,
        quota: q,
      });
      if (!flags.json) {
        out(`[${acc.agent}:${acc.name}] ${formatQuotaStatus(q)}`);
      }
    }
    if (flags.json) {
      out(results);
    }
    return;
  }

  throw new UsageError(`Unknown account command "${sub}". Expected list|add|use|remove|quota.`);
}
