import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { home } from '../bridge/runs.js';
import { AgentError } from './errors.js';
import { PermissionLevel } from '../types/index.js';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'plan', 'edit', 'full'] as const;

export const PERMISSION_RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  plan: 1,
  edit: 2,
  full: 3,
};

export interface AgentBridgeConfig {
  defaultPermissions?: PermissionLevel;
  permissionsCeiling?: PermissionLevel;
  defaultAgent?: string;
  autoRollback?: boolean;
  [key: string]: any;
}

export function globalConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), 'config.json');
}

export function projectConfigFile(cwd: string = process.cwd()): string {
  return path.join(path.resolve(cwd), '.agentbridge', 'config.json');
}

function readJsonFile(filePath: string): any {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: any): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    unlinkSync(tmp);
  } catch {
    // Fallback if atomic replacement was not possible
  }
}

/**
 * Loads merged configuration: defaults < global config < project config < env vars.
 */
export function loadConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): AgentBridgeConfig {
  const globalCfg = readJsonFile(globalConfigFile(env));
  const projectCfg = readJsonFile(projectConfigFile(cwd));

  const merged: AgentBridgeConfig = {
    ...globalCfg,
    ...projectCfg,
  };

  // Environment variables take precedence over config files
  const envDefault = env.AGENTBRIDGE_DEFAULT_PERMS || env.AGENTBRIDGE_DEFAULT_PERMISSIONS;
  if (envDefault && PERMISSION_LEVELS.includes(envDefault as PermissionLevel)) {
    merged.defaultPermissions = envDefault as PermissionLevel;
  }

  const envCeiling = env.AGENTBRIDGE_PERMS_CEILING || env.AGENTBRIDGE_PERMS;
  if (envCeiling && PERMISSION_LEVELS.includes(envCeiling as PermissionLevel)) {
    merged.permissionsCeiling = envCeiling as PermissionLevel;
  }

  return merged;
}

/**
 * Returns the effective permission ceiling (defaults to 'full').
 */
export function getPermissionsCeiling(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PermissionLevel {
  const envCeiling = env.AGENTBRIDGE_PERMS_CEILING || env.AGENTBRIDGE_PERMS;
  if (envCeiling && PERMISSION_LEVELS.includes(envCeiling as PermissionLevel)) {
    return envCeiling as PermissionLevel;
  }
  const cfg = loadConfig(cwd, env);
  return cfg.permissionsCeiling || 'full';
}

/**
 * Returns the effective default permission level (defaults to 'read-only' for security).
 */
export function getDefaultPermissions(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PermissionLevel {
  const envDefault = env.AGENTBRIDGE_DEFAULT_PERMS || env.AGENTBRIDGE_DEFAULT_PERMISSIONS;
  if (envDefault && PERMISSION_LEVELS.includes(envDefault as PermissionLevel)) {
    return envDefault as PermissionLevel;
  }
  const cfg = loadConfig(cwd, env);
  return cfg.defaultPermissions || 'read-only';
}

/**
 * Normalizes and validates requested permissions against ceiling and default.
 */
export function resolvePermissionLevel(
  requested?: string | null,
  options?: { env?: NodeJS.ProcessEnv; cwd?: string }
): { permissions: PermissionLevel; ceiling: PermissionLevel; isDefault: boolean } {
  const env = options?.env || process.env;
  const cwd = options?.cwd || process.cwd();

  const ceiling = getPermissionsCeiling(env, cwd);
  const def = getDefaultPermissions(env, cwd);

  const isDefault = requested == null;
  const perms = (isDefault ? def : requested) as PermissionLevel;

  if (!PERMISSION_LEVELS.includes(perms)) {
    throw new AgentError('BAD_OPTION', `permissions must be one of ${PERMISSION_LEVELS.join('|')}`);
  }

  if (PERMISSION_RANK[perms] > PERMISSION_RANK[ceiling]) {
    throw new AgentError(
      'BAD_OPTION',
      `permissions "${perms}" exceeds the configured permission ceiling "${ceiling}" (increase ceiling or configure permission)`
    );
  }

  return { permissions: perms, ceiling, isDefault };
}

/**
 * Saves multiple configuration keys.
 */
export function saveConfig(
  cfg: Partial<AgentBridgeConfig>,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  for (const [k, v] of Object.entries(cfg)) {
    setConfigValue(k, v, options);
  }
}

/**
 * Sets a configuration key globally or for the current project.
 */
export function setConfigValue(
  key: string,
  value: any,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  const isGlobal = options?.global ?? false;
  const filePath = isGlobal ? globalConfigFile(options?.env) : projectConfigFile(options?.cwd);

  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // kebab to camel
  if (normalizedKey === 'defaultPermissions' || normalizedKey === 'permissionsCeiling') {
    if (!PERMISSION_LEVELS.includes(value)) {
      throw new AgentError(
        'BAD_OPTION',
        `Invalid permission level "${value}". Expected one of: ${PERMISSION_LEVELS.join(', ')}`
      );
    }
  }

  const current = readJsonFile(filePath);
  current[normalizedKey] = value;
  writeJsonFile(filePath, current);
}

/**
 * Gets a configuration value.
 */
export function getConfigValue(
  key: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): any {
  const cfg = loadConfig(options?.cwd, options?.env);
  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return cfg[normalizedKey] ?? cfg[key];
}

/**
 * Removes a configuration key or clears the config file.
 */
export function resetConfigValue(
  key?: string,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  const isGlobal = options?.global ?? false;
  const filePath = isGlobal ? globalConfigFile(options?.env) : projectConfigFile(options?.cwd);
  if (!existsSync(filePath)) return;

  if (!key) {
    unlinkSync(filePath);
    return;
  }

  const current = readJsonFile(filePath);
  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  delete current[normalizedKey];
  delete current[key];
  writeJsonFile(filePath, current);
}
