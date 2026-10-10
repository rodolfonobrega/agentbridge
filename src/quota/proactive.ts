import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Direct proactive quota querying before hitting 429 errors (inspired by Orca).
// Queries provider usage APIs (Anthropic OAuth usage API, ChatGPT backend API)
// with threshold-based health status and fallback mock/fixture support.

export const ANTHROPIC_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface AnthropicUsage {
  fiveHourPercent: number;
  sevenDayPercent: number;
  fiveHourResetsAt: number | null;
  sevenDayResetsAt: number | null;
  fiveHour?: { usedPercent: number; resetsAt: number | null };
  sevenDay?: { usedPercent: number; resetsAt: number | null };
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  raw?: any;
}

export interface CodexUsage {
  primaryPercent: number;
  resetsAt: number | null;
  secondaryPercent?: number;
  windowMinutes: number;
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  raw?: any;
}

export interface ProactiveQuotaHealth {
  agent: string;
  usedPercent: number;
  secondaryPercent?: number;
  windowMinutes: number;
  resetAt: number | null;
  okToProceed: boolean;
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  blockingWindow?: 'primary' | 'secondary' | null;
}

export interface QuotaQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  fixture?: any;
  thresholdPercent?: number;
  env?: NodeJS.ProcessEnv;
  profileDir?: string;
}

const registeredFixtures = new Map<string, any>();

export const DEFAULT_MOCK_FIXTURES: Record<string, any> = {
  claude: {
    five_hour: { used_percentage: 15, resets_at: Date.now() + 300 * 60 * 1000 },
    seven_day: { used_percentage: 10, resets_at: Date.now() + 7 * 24 * 3600 * 1000 },
  },
  codex: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Date.now() + 18000 * 1000 },
    secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: Date.now() + 604800 * 1000 },
  },
};

export function setQuotaFixture(agent: string, fixture: any): void {
  registeredFixtures.set(agent.toLowerCase(), fixture);
}

export function clearQuotaFixtures(): void {
  registeredFixtures.clear();
}

export function parseResetTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export function parseAnthropicUsage(data: any): AnthropicUsage {
  const fiveHour = data?.five_hour || data?.session;
  const sevenDay = data?.seven_day || data?.weekly;

  const fiveHourPercent = Math.round(fiveHour?.used_percentage ?? fiveHour?.used_percent ?? 0);
  const sevenDayPercent = Math.round(sevenDay?.used_percentage ?? sevenDay?.used_percent ?? 0);
  const fiveHourResetsAt = parseResetTime(fiveHour?.resets_at || fiveHour?.reset_at);
  const sevenDayResetsAt = parseResetTime(sevenDay?.resets_at || sevenDay?.reset_at);

  return {
    fiveHourPercent,
    sevenDayPercent,
    fiveHourResetsAt,
    sevenDayResetsAt,
    fiveHour: fiveHour ? { usedPercent: fiveHourPercent, resetsAt: fiveHourResetsAt } : undefined,
    sevenDay: sevenDay ? { usedPercent: sevenDayPercent, resetsAt: sevenDayResetsAt } : undefined,
    raw: data,
  };
}

export function parseCodexUsage(data: any): CodexUsage {
  const primary = data?.primary_window || data?.session || data?.rate_limits?.session;
  const secondary = data?.secondary_window || data?.weekly || data?.rate_limits?.weekly;

  const primaryPercent = Math.round(primary?.used_percent ?? primary?.used_percentage ?? 0);
  const secondaryPercent = secondary
    ? Math.round(secondary?.used_percent ?? secondary?.used_percentage ?? 0)
    : undefined;
  const resetsAt = parseResetTime(primary?.reset_at || primary?.resets_at);
  const windowMinutes = Math.round((primary?.limit_window_seconds || 18000) / 60);

  return {
    primaryPercent,
    resetsAt,
    secondaryPercent,
    windowMinutes,
    raw: data,
  };
}

function isMockOrOffline(agent: string, options?: QuotaQueryOptions): boolean {
  if (options?.fixture !== undefined) return true;
  if (registeredFixtures.has(agent.toLowerCase())) return true;
  if (process.env.AGENTBRIDGE_OFFLINE === '1' || process.env.AGENTBRIDGE_PROACTIVE_MOCK === '1') return true;
  return false;
}

function readJsonFile(file: string): any {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code writes its login to <CLAUDE_CONFIG_DIR>/.credentials.json (default ~/.claude),
// with the token nested under claudeAiOauth. A profile dir (ab account add) is searched
// instead of the default home, so one account never reads another's login.
function claudeCredentialFiles(options: QuotaQueryOptions): string[] {
  const configDir =
    options.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const dir = options.profileDir || configDir;
  return [path.join(dir, '.credentials.json'), path.join(dir, 'credentials.json')];
}

// Codex writes its login to <CODEX_HOME>/auth.json (default ~/.codex), with the token under tokens.
function codexAuthFiles(options: QuotaQueryOptions): string[] {
  const codexHome = options.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const dir = options.profileDir || codexHome;
  return [path.join(dir, 'auth.json'), path.join(dir, '.auth')];
}

function claudeTokenFrom(c: any): string | undefined {
  return c?.claudeAiOauth?.accessToken || c?.accessToken || c?.token || c?.sessionToken || c?.apiKey || undefined;
}

export async function fetchAnthropicUsage(
  token: string,
  options: QuotaQueryOptions = {}
): Promise<AnthropicUsage> {
  if (options.fixture) {
    return parseAnthropicUsage(options.fixture);
  }

  const registered = registeredFixtures.get('claude') || registeredFixtures.get('anthropic');
  if (registered) {
    return parseAnthropicUsage(registered);
  }

  if (isMockOrOffline('claude', options)) {
    return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const f = options.fetchImpl || globalThis.fetch;

  try {
    const res = await f(ANTHROPIC_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'agentbridge/0.2.0',
      },
      signal,
    });
    if (!res.ok) {
      if (options.fixture || registeredFixtures.has('claude')) {
        return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
      }
      return {
        fiveHourPercent: 0,
        sevenDayPercent: 0,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        status: 'error',
        error: `HTTP ${res.status}: ${res.statusText || 'request failed'}`,
        raw: null,
      };
    }
    const body = await res.json();
    const parsed = parseAnthropicUsage(body);
    parsed.status = 'ok';
    return parsed;
  } catch (e: any) {
    if (options.fixture || registeredFixtures.has('claude')) {
      return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
    }
    return {
      fiveHourPercent: 0,
      sevenDayPercent: 0,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      status: 'error',
      error: String(e?.message || e),
      raw: null,
    };
  }
}

export async function fetchCodexUsage(
  token: string,
  options: QuotaQueryOptions = {},
  accountId?: string
): Promise<CodexUsage> {
  if (options.fixture) {
    return parseCodexUsage(options.fixture);
  }

  const registered = registeredFixtures.get('codex') || registeredFixtures.get('chatgpt');
  if (registered) {
    return parseCodexUsage(registered);
  }

  if (isMockOrOffline('codex', options)) {
    return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const f = options.fetchImpl || globalThis.fetch;

  try {
    const res = await f(CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        'User-Agent': 'agentbridge/0.2.0',
      },
      signal,
    });
    if (!res.ok) {
      if (options.fixture || registeredFixtures.has('codex')) {
        return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
      }
      return {
        primaryPercent: 0,
        resetsAt: null,
        windowMinutes: 300,
        status: 'error',
        error: `HTTP ${res.status}: ${res.statusText || 'request failed'}`,
        raw: null,
      };
    }
    const body = await res.json();
    const parsed = parseCodexUsage(body);
    parsed.status = 'ok';
    return parsed;
  } catch (e: any) {
    if (options.fixture || registeredFixtures.has('codex')) {
      return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
    }
    return {
      primaryPercent: 0,
      resetsAt: null,
      windowMinutes: 300,
      status: 'error',
      error: String(e?.message || e),
      raw: null,
    };
  }
}

export async function getProactiveQuotaStatus(
  agent: string,
  token?: string,
  options: QuotaQueryOptions = {}
): Promise<ProactiveQuotaHealth> {
  const norm = agent.toLowerCase().trim();
  const threshold = options.thresholdPercent ?? 95;

  if (norm === 'claude' || norm === 'anthropic') {
    let effectiveToken = token || options.env?.ANTHROPIC_API_KEY || options.env?.CLAUDE_CODE_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_TOKEN;
    if (!effectiveToken) {
      for (const file of claudeCredentialFiles(options)) {
        effectiveToken = claudeTokenFrom(readJsonFile(file));
        if (effectiveToken) break;
      }
    }
    if (!effectiveToken && !isMockOrOffline('claude', options)) {
      return {
        agent,
        usedPercent: 0,
        windowMinutes: 300,
        resetAt: null,
        okToProceed: false,
        status: 'unknown',
        error: 'No credential or API token configured',
      };
    }
    const usage = await fetchAnthropicUsage(effectiveToken || 'dummy', options);
    const usedPercent = usage.fiveHourPercent;
    const secondaryPercent = usage.sevenDayPercent;
    const windowMinutes = 300;
    const resetAt = usage.fiveHourResetsAt;
    const fiveHourBlocked = usedPercent >= threshold;
    const sevenDayBlocked = secondaryPercent >= 98;
    const hasError = usage.status === 'error';
    const okToProceed = !hasError && !fiveHourBlocked && !sevenDayBlocked;
    const blockingWindow = sevenDayBlocked ? 'secondary' : fiveHourBlocked ? 'primary' : null;

    return {
      agent,
      usedPercent,
      secondaryPercent,
      windowMinutes,
      resetAt,
      okToProceed,
      status: usage.status || 'ok',
      error: usage.error,
      blockingWindow,
    };
  }

  if (norm === 'codex' || norm === 'chatgpt' || norm === 'openai') {
    let effectiveToken = token || options.env?.CODEX_TOKEN || options.env?.OPENAI_API_KEY || process.env.CODEX_TOKEN || process.env.OPENAI_API_KEY;
    let accountId: string | undefined;
    for (const file of codexAuthFiles(options)) {
      if (effectiveToken) break;
      const a = readJsonFile(file);
      effectiveToken = a?.tokens?.access_token || a?.accessToken || a?.token;
      accountId = a?.tokens?.account_id;
    }
    if (!effectiveToken && !isMockOrOffline('codex', options)) {
      return {
        agent,
        usedPercent: 0,
        windowMinutes: 300,
        resetAt: null,
        okToProceed: false,
        status: 'unknown',
        error: 'No credential or API token configured',
      };
    }
    const usage = await fetchCodexUsage(effectiveToken || 'dummy', options, accountId);
    const usedPercent = usage.primaryPercent;
    const secondaryPercent = usage.secondaryPercent ?? 0;
    const windowMinutes = usage.windowMinutes || 300;
    const resetAt = usage.resetsAt;
    const primaryBlocked = usedPercent >= threshold;
    const secondaryBlocked = secondaryPercent >= threshold;
    const hasError = usage.status === 'error';
    const okToProceed = !hasError && !primaryBlocked && !secondaryBlocked;
    const blockingWindow = secondaryBlocked ? 'secondary' : primaryBlocked ? 'primary' : null;

    return {
      agent,
      usedPercent,
      secondaryPercent,
      windowMinutes,
      resetAt,
      okToProceed,
      status: usage.status || 'ok',
      error: usage.error,
      blockingWindow,
    };
  }

  // Other agents or generic mock
  const customFixture = registeredFixtures.get(norm);
  if (customFixture) {
    const usedPercent = Number(customFixture.usedPercent ?? customFixture.used_percent ?? 0);
    const windowMinutes = Number(customFixture.windowMinutes ?? 300);
    const resetAt = parseResetTime(customFixture.resetAt ?? customFixture.reset_at);
    const okToProceed = usedPercent < threshold;
    return {
      agent,
      usedPercent,
      windowMinutes,
      resetAt,
      okToProceed,
      status: 'ok',
    };
  }

  return {
    agent,
    usedPercent: 0,
    windowMinutes: 0,
    resetAt: null,
    okToProceed: true,
    status: 'ok',
  };
}

export function formatQuotaStatus(status: ProactiveQuotaHealth): string {
  if (status.status === 'error') {
    return `[${status.agent}] ERROR: ${status.error || 'request failed'}`;
  }
  if (status.status === 'unknown') {
    return `[${status.agent}] UNKNOWN: ${status.error || 'no credentials'}`;
  }
  const state = status.okToProceed ? 'OK' : 'THROTTLED';
  const blockPart = status.blockingWindow ? ` (${status.blockingWindow} window blocked)` : '';
  const resetPart = status.resetAt ? `, reset: ${new Date(status.resetAt).toISOString()}` : '';
  return `[${status.agent}] ${status.usedPercent}% used (${status.windowMinutes}m window${resetPart})${blockPart} - ${state}`;
}

export function formatQuotaForPrompt(status: ProactiveQuotaHealth): string {
  const resetStr = status.resetAt ? new Date(status.resetAt).toISOString() : 'none';
  return `[PROACTIVE QUOTA - ${status.agent.toUpperCase()}]\nUsed: ${status.usedPercent}%\nWindow: ${status.windowMinutes}m\nReset: ${resetStr}\nStatus: ${status.okToProceed ? 'OK' : 'THROTTLED'}`;
}

export async function cmdQuota(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const agent = _[0] || 'claude';
  const token = flags.token || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  const status = await getProactiveQuotaStatus(agent, token, {
    thresholdPercent: flags.threshold ? Number(flags.threshold) : undefined,
  });
  if (flags.json) {
    io.out(status);
  } else {
    io.out(formatQuotaStatus(status));
  }
}

