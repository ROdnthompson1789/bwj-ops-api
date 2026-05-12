// YouTube data-pull cron logic for Watchman Phase 1 Step 1.4.
//
// Pulls daily snapshots for every tenant platform with source='youtube_api'.
// Uses two YouTube APIs per channel:
//   - Data API v3 channels.list -> current lifetime totals (subs, views)
//   - Analytics API v2 reports  -> day-before-yesterday daily deltas
//
// Channel -> credentials mapping is data-driven via the credentials_key
// field on TenantPlatform. KV keys for a given credentials_key:
//   <credentials_key>_client_id
//   <credentials_key>_client_secret
//   <credentials_key>_refresh_token
//
// Per-channel failures are isolated via Promise.allSettled. The cron always
// writes one watchman_audit_log row summarizing succeeded + failed channels.

import type { Bindings } from "./types";
import { getYouTubeApiKey } from "./kv";
import type { TenantConfig, TenantPlatform } from "./watchman";

const YT_ANALYTICS_METRICS = [
  "views",
  "subscribersGained",
  "subscribersLost",
  "estimatedMinutesWatched",
  "averageViewDuration",
].join(",");

type PullPhase =
  | "config"
  | "refresh_token"
  | "data_api"
  | "analytics_api"
  | "db_write";

export interface PullSuccess {
  platform: string;
  channel_id: string;
  window_start: string;
  window_end: string;
  rows_written: number;
  latest_day: string | null;
  latest_views: number;
  followers: number;
}

export interface PullFailure {
  platform: string;
  channel_id: string;
  phase: PullPhase;
  error: string;
}

export interface YouTubePullResult {
  window_start: string;
  window_end: string;
  succeeded: PullSuccess[];
  failed: PullFailure[];
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// 7-day rolling window ending day-before-yesterday UTC. The two-day lag gives
// YouTube Analytics its documented 24-48h finalization buffer; the multi-day
// width self-heals any prior day the cron previously stored as zero.
const PULL_WINDOW_DAYS = 7;

function computePullWindow(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (PULL_WINDOW_DAYS - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function loadTenantConfig(
  env: Bindings,
  tenantId: string,
): Promise<TenantConfig> {
  const row = await env.DB.prepare(
    "SELECT config_json FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<{ config_json: string }>();
  if (!row) throw new Error(`tenant_not_found: ${tenantId}`);
  return JSON.parse(row.config_json) as TenantConfig;
}

async function refreshAccessToken(
  env: Bindings,
  credentialsKey: string,
): Promise<string> {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    env.SECRETS.get(`${credentialsKey}_client_id`),
    env.SECRETS.get(`${credentialsKey}_client_secret`),
    env.SECRETS.get(`${credentialsKey}_refresh_token`),
  ]);
  if (!clientId) throw new Error(`KV missing: ${credentialsKey}_client_id`);
  if (!clientSecret)
    throw new Error(`KV missing: ${credentialsKey}_client_secret`);
  if (!refreshToken)
    throw new Error(`KV missing: ${credentialsKey}_refresh_token`);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token response missing access_token");
  return json.access_token;
}

interface ChannelStats {
  subscriberCount: number;
  viewCount: number;
}

async function fetchChannelStats(
  apiKey: string,
  channelId: string,
): Promise<ChannelStats> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `data API failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    items?: Array<{
      statistics?: { subscriberCount?: string; viewCount?: string };
    }>;
  };
  const stats = json.items?.[0]?.statistics;
  if (!stats)
    throw new Error(`data API returned no channel stats for ${channelId}`);
  return {
    subscriberCount: parseInt(stats.subscriberCount ?? "0", 10),
    viewCount: parseInt(stats.viewCount ?? "0", 10),
  };
}

interface DailyAnalyticsRow {
  day: string;
  views: number;
  subscribersGained: number;
  subscribersLost: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
}

async function fetchAnalytics(
  accessToken: string,
  channelId: string,
  startDate: string,
  endDate: string,
): Promise<DailyAnalyticsRow[]> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", `channel==${channelId}`);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", YT_ANALYTICS_METRICS);
  // Without `dimensions=day`, the Analytics API returns `rows: []` for any
  // query, silently zeroing every metric. With `dimensions=day` we get one
  // row per finalized day in [startDate, endDate]. Verified against owner
  // OAuth for both Main and Shorts channels on 2026-05-12. Same call works
  // for any future tenant using channel-owner OAuth.
  url.searchParams.set("dimensions", "day");
  url.searchParams.set("sort", "day");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `analytics API failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    columnHeaders?: { name: string }[];
    rows?: (string | number | null)[][];
  };
  const headers = json.columnHeaders ?? [];
  const idx = (name: string) => headers.findIndex((h) => h.name === name);
  const di = idx("day");
  const vi = idx("views");
  const sgi = idx("subscribersGained");
  const sli = idx("subscribersLost");
  const wti = idx("estimatedMinutesWatched");
  const avi = idx("averageViewDuration");
  const num = (row: (string | number | null)[], i: number): number => {
    if (i < 0) return 0;
    const v = row[i];
    return typeof v === "number" ? v : 0;
  };
  const out: DailyAnalyticsRow[] = [];
  for (const row of json.rows ?? []) {
    if (di < 0) continue;
    const day = row[di];
    if (typeof day !== "string") continue;
    out.push({
      day,
      views: num(row, vi),
      subscribersGained: num(row, sgi),
      subscribersLost: num(row, sli),
      estimatedMinutesWatched: num(row, wti),
      averageViewDuration: num(row, avi),
    });
  }
  return out;
}

async function pullPlatform(
  env: Bindings,
  tenantId: string,
  platform: TenantPlatform,
  window: { startDate: string; endDate: string },
  apiKey: string,
): Promise<PullSuccess | PullFailure> {
  const channelId = platform.channel_id ?? "";
  const credentialsKey = platform.credentials_key;
  if (!channelId) {
    return {
      platform: platform.id,
      channel_id: "",
      phase: "config",
      error: "missing channel_id",
    };
  }
  if (!credentialsKey) {
    return {
      platform: platform.id,
      channel_id: channelId,
      phase: "config",
      error: "missing credentials_key",
    };
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(env, credentialsKey);
  } catch (err) {
    return {
      platform: platform.id,
      channel_id: channelId,
      phase: "refresh_token",
      error: errMsg(err),
    };
  }

  let stats: ChannelStats;
  try {
    stats = await fetchChannelStats(apiKey, channelId);
  } catch (err) {
    return {
      platform: platform.id,
      channel_id: channelId,
      phase: "data_api",
      error: errMsg(err),
    };
  }

  let analyticsRows: DailyAnalyticsRow[];
  try {
    analyticsRows = await fetchAnalytics(
      accessToken,
      channelId,
      window.startDate,
      window.endDate,
    );
  } catch (err) {
    return {
      platform: platform.id,
      channel_id: channelId,
      phase: "analytics_api",
      error: errMsg(err),
    };
  }

  // CTR: not pulled from cron. Channel-aggregate CTR is computed at query
  // time from per-video CTR in video_snapshots (Phase 2). YouTube Analytics
  // API doesn't expose channel-aggregate CTR to channel-owner OAuth scope.
  // Same architecture works for BWJ and any future end user.
  if (analyticsRows.length > 0) {
    try {
      const stmts = analyticsRows.map((day) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO daily_snapshots
             (id, tenant_id, platform, snapshot_date,
              views, followers, new_followers_today, ctr,
              watch_time_minutes, reach, activity_count, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api')`,
        ).bind(
          crypto.randomUUID(),
          tenantId,
          platform.id,
          day.day,
          day.views,
          stats.subscriberCount,
          day.subscribersGained - day.subscribersLost,
          null,
          day.estimatedMinutesWatched,
          null,
          null,
        ),
      );
      await env.DB.batch(stmts);
    } catch (err) {
      return {
        platform: platform.id,
        channel_id: channelId,
        phase: "db_write",
        error: errMsg(err),
      };
    }
  }

  const latest = analyticsRows[analyticsRows.length - 1] ?? null;
  return {
    platform: platform.id,
    channel_id: channelId,
    window_start: window.startDate,
    window_end: window.endDate,
    rows_written: analyticsRows.length,
    latest_day: latest?.day ?? null,
    latest_views: latest?.views ?? 0,
    followers: stats.subscriberCount,
  };
}

function isFailure(r: PullSuccess | PullFailure): r is PullFailure {
  return "phase" in r;
}

export async function runYouTubePull(
  env: Bindings,
): Promise<YouTubePullResult> {
  const tenantId = env.TENANT_ID;
  const window = computePullWindow();
  const succeeded: PullSuccess[] = [];
  const failed: PullFailure[] = [];

  try {
    const apiKey = await getYouTubeApiKey(env);
    if (!apiKey) throw new Error("KV missing: youtube_api_key");
    const config = await loadTenantConfig(env, tenantId);
    const ytPlatforms = config.platforms.filter(
      (p) => p.source === "youtube_api",
    );

    const results = await Promise.allSettled(
      ytPlatforms.map((p) =>
        pullPlatform(env, tenantId, p, window, apiKey),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const p = ytPlatforms[i];
      if (r.status === "fulfilled") {
        if (isFailure(r.value)) failed.push(r.value);
        else succeeded.push(r.value);
      } else {
        failed.push({
          platform: p.id,
          channel_id: p.channel_id ?? "",
          phase: "config",
          error: errMsg(r.reason),
        });
      }
    }
  } catch (err) {
    failed.push({
      platform: "<setup>",
      channel_id: "",
      phase: "config",
      error: errMsg(err),
    });
  }

  // Audit log is always written, even on full failure.
  try {
    await env.DB.prepare(
      `INSERT INTO watchman_audit_log
         (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'cron_youtube_pull', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        JSON.stringify({
          window_start: window.startDate,
          window_end: window.endDate,
          channels_attempted: succeeded.length + failed.length,
          succeeded,
          failed,
        }),
      )
      .run();
  } catch (err) {
    console.error("cron_youtube_pull: audit write failed", errMsg(err));
  }

  return {
    window_start: window.startDate,
    window_end: window.endDate,
    succeeded,
    failed,
  };
}
