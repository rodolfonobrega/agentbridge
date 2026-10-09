import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, statSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { syncSharedResources, unlinkResource } from './shared-resources.js';
import { isValidAccountAgent, VALID_ACCOUNT_AGENTS } from './catalog.js';

export interface AccountRecord {
  name: string;
  agent: string;
  profileDir: string;
  createdAt: number;
  lastUsedAt?: number;
  env?: Record<string, string>;
  email?: string;
  plan?: string;
}

export interface AccountsManifest {
  version: 1;
  active: Record<string, string>;
  accounts: Record<string, AccountRecord[]>;
}

export function getBaseDir(customBase?: string): string {
  return customBase || process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');
}

export function getAccountsFilePath(customBase?: string): string {
  return path.join(getBaseDir(customBase), 'accounts.json');
}

export function getManagedProfileDir(agent: string, name: string, customBase?: string): string {
  return path.join(getBaseDir(customBase), 'profiles', agent.toLowerCase(), name.toLowerCase());
}

export function loadAccountsManifest(customBase?: string): AccountsManifest {
  const filePath = getAccountsFilePath(customBase);
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (data && typeof data === 'object') {
        return {
          version: 1,
          active: data.active && typeof data.active === 'object' ? data.active : {},
          accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
        };
      }
    }
  } catch {
    /* fallback to blank */
  }
  return { version: 1, active: {}, accounts: {} };
}

export function saveAccountsManifest(manifest: AccountsManifest, customBase?: string): void {
  const baseDir = getBaseDir(customBase);
  mkdirSync(baseDir, { recursive: true });
  const filePath = getAccountsFilePath(customBase);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (err: any) {
    try {
      writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      rmSync(tmp, { force: true });
    } catch (fallbackErr: any) {
      throw new Error(`Failed to save accounts manifest to "${filePath}": ${fallbackErr.message || err.message}`);
    }
  }
}

export function getDefaultSystemAgentDir(agent: string): string | null {
  const ag = agent.toLowerCase();
  if (ag === 'claude') {
    return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  }
  if (ag === 'codex') {
    return process.env.CODEX_HOME || path.join(homedir(), '.codex');
  }
  if (ag === 'pi') {
    return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
  }
  if (ag === 'opencode') {
    return process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode') : path.join(homedir(), '.local', 'share', 'opencode');
  }
  return null;
}

export function detectAccountInfo(agent: string, profileDir: string): { email?: string; plan?: string } {
  const ag = agent.toLowerCase();
  try {
    if (ag === 'claude') {
      const credsFile = path.join(profileDir, 'credentials.json');
      if (existsSync(credsFile)) {
        const c = JSON.parse(readFileSync(credsFile, 'utf8'));
        if (c?.email) return { email: c.email, plan: c.tier || c.plan };
      }
      const authFile = path.join(profileDir, 'auth.json');
      if (existsSync(authFile)) {
        const a = JSON.parse(readFileSync(authFile, 'utf8'));
        if (a?.email) return { email: a.email, plan: a.plan };
      }
    } else if (ag === 'codex') {
      const authFile = path.join(profileDir, '.auth');
      if (existsSync(authFile)) {
        const a = JSON.parse(readFileSync(authFile, 'utf8'));
        if (a?.email) return { email: a.email, plan: a.plan };
      }
    } else if (ag === 'pi') {
      const authFile = path.join(profileDir, 'auth.json');
      if (existsSync(authFile)) {
        const a = JSON.parse(readFileSync(authFile, 'utf8'));
        if (a?.email) return { email: a.email, plan: a.plan };
      }
    }
  } catch {
    /* non-fatal */
  }
  return {};
}

export function addAccount(
  agent: string,
  name: string,
  options: {
    copyCurrent?: boolean;
    /** Link skills/prompts/plugins (and mirror Codex MCP servers) from the system agent dir. Default true. */
    share?: boolean;
    env?: Record<string, string>;
    baseDir?: string;
  } = {}
): AccountRecord {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid account name "${name}". Use alphanumeric characters, hyphens and underscores.`);
  }
  const ag = agent.toLowerCase().trim();
  if (!isValidAccountAgent(ag)) {
    throw new Error(`Invalid agent "${agent}". Expected one of: ${VALID_ACCOUNT_AGENTS.join(', ')}`);
  }
  const manifest = loadAccountsManifest(options.baseDir);
  const existingList = manifest.accounts[ag] || [];
  if (existingList.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Account "${name}" already exists for agent "${ag}".`);
  }

  const baseProfiles = path.resolve(getBaseDir(options.baseDir), 'profiles');
  const profileDir = path.resolve(getManagedProfileDir(ag, name, options.baseDir));
  const rel = path.relative(baseProfiles, profileDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Profile directory "${profileDir}" escapes managed profiles base directory`);
  }

  mkdirSync(profileDir, { recursive: true });

  if (options.copyCurrent) {
    const srcDir = getDefaultSystemAgentDir(ag);
    if (srcDir && existsSync(srcDir)) {
      try {
        cpSync(srcDir, profileDir, { recursive: true });
      } catch {
        /* best effort */
      }
    }
  } else if (options.share !== false) {
    const srcDir = getDefaultSystemAgentDir(ag);
    if (srcDir && existsSync(srcDir) && path.resolve(srcDir) !== path.resolve(profileDir)) {
      try {
        syncSharedResources(ag, srcDir, profileDir);
      } catch {
        /* best effort */
      }
    }
  }

  const detected = detectAccountInfo(ag, profileDir);
  const record: AccountRecord = {
    name,
    agent: ag,
    profileDir,
    createdAt: Date.now(),
    env: options.env ? { ...options.env } : undefined,
    email: detected.email,
    plan: detected.plan,
  };

  existingList.push(record);
  manifest.accounts[ag] = existingList;
  if (!manifest.active[ag]) {
    manifest.active[ag] = name;
  }
  saveAccountsManifest(manifest, options.baseDir);
  return record;
}

export function removeAccount(
  agent: string,
  name: string,
  options: { deleteProfileDir?: boolean; baseDir?: string } = {}
): boolean {
  const ag = agent.toLowerCase().trim();
  if (!isValidAccountAgent(ag)) {
    throw new Error(`Invalid agent "${agent}". Expected one of: ${VALID_ACCOUNT_AGENTS.join(', ')}`);
  }
  const manifest = loadAccountsManifest(options.baseDir);
  const existingList = manifest.accounts[ag] || [];
  const idx = existingList.findIndex((a) => a.name.toLowerCase() === name.toLowerCase());
  if (idx < 0) return false;

  const [removed] = existingList.splice(idx, 1);
  manifest.accounts[ag] = existingList;

  if (manifest.active[ag]?.toLowerCase() === name.toLowerCase()) {
    if (existingList.length > 0) {
      manifest.active[ag] = existingList[0].name;
    } else {
      delete manifest.active[ag];
    }
  }

  saveAccountsManifest(manifest, options.baseDir);

  if (options.deleteProfileDir && removed.profileDir) {
    const baseProfiles = path.resolve(getBaseDir(options.baseDir), 'profiles');
    const targetDir = path.resolve(removed.profileDir);
    const rel = path.relative(baseProfiles, targetDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to delete profile directory "${targetDir}" outside managed profiles base`);
    }

    // Drop shared-resource links first so the recursive delete can never reach the user's real skills/plugins.
    let safe = true;
    try {
      for (const e of readdirSync(removed.profileDir)) {
        const p = path.join(removed.profileDir, e);
        let link = false;
        try {
          link = lstatSync(p).isSymbolicLink();
        } catch {
          /* gone */
        }
        if (link && !unlinkResource(p)) safe = false;
      }
    } catch {
      /* dir missing */
    }
    if (safe) {
      try {
        rmSync(removed.profileDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return true;
}

export function setActiveAccount(agent: string, name: string, customBase?: string): void {
  const ag = agent.toLowerCase();
  const manifest = loadAccountsManifest(customBase);
  const existingList = manifest.accounts[ag] || [];
  const hit = existingList.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw new Error(`Account "${name}" not found for agent "${ag}".`);
  }
  manifest.active[ag] = hit.name;
  saveAccountsManifest(manifest, customBase);
}

export function getActiveAccount(agent: string, customBase?: string): AccountRecord | null {
  const ag = agent.toLowerCase();
  const manifest = loadAccountsManifest(customBase);
  const activeName = manifest.active[ag];
  if (!activeName) return null;
  const list = manifest.accounts[ag] || [];
  return list.find((a) => a.name.toLowerCase() === activeName.toLowerCase()) || null;
}

export function listAccounts(agent?: string, customBase?: string): AccountRecord[] {
  const manifest = loadAccountsManifest(customBase);
  if (agent) {
    return manifest.accounts[agent.toLowerCase()] || [];
  }
  const out: AccountRecord[] = [];
  for (const list of Object.values(manifest.accounts)) {
    out.push(...list);
  }
  return out;
}

export function getAccountEnv(agent: string, name?: string, customBase?: string): Record<string, string> {
  const ag = agent.toLowerCase();
  const manifest = loadAccountsManifest(customBase);
  const list = manifest.accounts[ag] || [];
  if (!list.length) return {};

  let record: AccountRecord | undefined;
  if (name) {
    record = list.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!record) {
      throw new Error(`Account "${name}" not found for agent "${ag}".`);
    }
  } else {
    const activeName = manifest.active[ag];
    record = list.find((a) => a.name.toLowerCase() === activeName?.toLowerCase());
    if (!record) record = list[0];
  }

  if (!record) return {};

  const env: Record<string, string> = {};
  if (ag === 'claude') {
    env.CLAUDE_CONFIG_DIR = record.profileDir;
    env.ANTHROPIC_API_KEY = '';
    env.ANTHROPIC_AUTH_TOKEN = '';
  } else if (ag === 'codex') {
    env.CODEX_HOME = record.profileDir;
  } else if (ag === 'pi') {
    env.PI_CODING_AGENT_DIR = record.profileDir;
  } else if (ag === 'opencode') {
    env.OPENCODE_DATA_DIR = record.profileDir;
    env.XDG_DATA_HOME = path.dirname(record.profileDir);
  } else if (ag === 'agy') {
    env.ANTIGRAVITY_CONFIG_DIR = record.profileDir;
  }

  if (record.env) {
    Object.assign(env, record.env);
  }
  return env;
}

export function getAccountsAsPool(customBase?: string): any {
  const manifest = loadAccountsManifest(customBase);
  const poolConfig: Record<string, any> = {
    strategy: 'round-robin',
  };

  for (const [agent, list] of Object.entries(manifest.accounts)) {
    if (list && list.length > 0) {
      poolConfig[agent] = list.map((acc) => ({
        name: acc.name,
        env: getAccountEnv(agent, acc.name, customBase),
      }));
    }
  }
  return poolConfig;
}
