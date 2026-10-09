// Proactive rate limit and quota prober inspired by Orca.
// Queries provider usage APIs (Anthropic OAuth usage API, ChatGPT backend API)
// to fetch exact session/weekly window usage before hitting HTTP 429 errors.

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes?: number;
}

export interface QuotaStatus {
  provider: 'claude' | 'codex' | string;
  sessionWindow: RateLimitWindow | null;
  weeklyWindow: RateLimitWindow | null;
  isThrottled: boolean;
  raw?: any;
  updatedAt: number;
}

function parseResetTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export function parseClaudeUsageResponse(data: any): QuotaStatus {
  const fiveHour = data?.five_hour;
  const sevenDay = data?.seven_day;

  const sessionWindow: RateLimitWindow | null = fiveHour && typeof fiveHour.used_percentage === 'number'
    ? {
        usedPercent: Math.round(fiveHour.used_percentage),
        resetsAt: parseResetTime(fiveHour.resets_at),
        windowMinutes: 300,
      }
    : null;

  const weeklyWindow: RateLimitWindow | null = sevenDay && typeof sevenDay.used_percentage === 'number'
    ? {
        usedPercent: Math.round(sevenDay.used_percentage),
        resetsAt: parseResetTime(sevenDay.resets_at),
        windowMinutes: 10080,
      }
    : null;

  const isThrottled = Boolean(
    (sessionWindow && sessionWindow.usedPercent >= 95) ||
    (weeklyWindow && weeklyWindow.usedPercent >= 98)
  );

  return {
    provider: 'claude',
    sessionWindow,
    weeklyWindow,
    isThrottled,
    raw: data,
    updatedAt: Date.now(),
  };
}

export function parseCodexUsageResponse(data: any): QuotaStatus {
  const primary = data?.primary_window || data?.session || data?.rate_limits?.session;
  const secondary = data?.secondary_window || data?.weekly || data?.rate_limits?.weekly;

  const sessionWindow: RateLimitWindow | null = primary && typeof primary.used_percent === 'number'
    ? {
        usedPercent: Math.round(primary.used_percent),
        resetsAt: parseResetTime(primary.reset_at || primary.resets_at),
        windowMinutes: Math.round((primary.limit_window_seconds || 18000) / 60),
      }
    : null;

  const weeklyWindow: RateLimitWindow | null = secondary && typeof secondary.used_percent === 'number'
    ? {
        usedPercent: Math.round(secondary.used_percent),
        resetsAt: parseResetTime(secondary.reset_at || secondary.resets_at),
        windowMinutes: Math.round((secondary.limit_window_seconds || 604800) / 60),
      }
    : null;

  const isThrottled = Boolean(
    (sessionWindow && sessionWindow.usedPercent >= 95) ||
    (weeklyWindow && weeklyWindow.usedPercent >= 98)
  );

  return {
    provider: 'codex',
    sessionWindow,
    weeklyWindow,
    isThrottled,
    raw: data,
    updatedAt: Date.now(),
  };
}
