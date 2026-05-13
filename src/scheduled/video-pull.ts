// Per-video YouTube Analytics cron -- Phase 2 Step 2.2.
//
// Populates video_snapshots so the constellation graph has data.
// Runs at 20 11 * * * (between threshold eval at 11:15 and social pull at 11:30).
//
// One Analytics API call per channel using dimensions=day,video returns all
// videos in a single response rather than one call per video. Much more
// quota-efficient for channels with many videos.
//
// Rule 6: reads platform list from tenant config, works for any tenant.
// Path Z: ctr column is left null -- computed at query time from per-video data.

import type { Bindings } from "../lib/types";
import { getYouTubeApiKey } from "../lib/kv";
import type { TenantConfig, TenantPlatform } from "../lib/watchman";

const PULL_WINDOW_DAYS = 7;
const MAX_VIDEOS = 50;

const YT_VIDEO_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersGained",
  "subscribersLost",
].join(",");

export interface VideoPullResult {
  window_start: string;
  window_end: string;
  platforms: Array<{
    platform: string;
    channel_id: string;
    videos_found: number;
    rows_written: number;
    error?: string;
  }>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

// Fetch recent video IDs + titles from Data API search endpoint.
async function fetchVideoList(
  apiKey: string,
  channelId: string,
): Promise<Map<string, string>> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "id,snippet");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "date");
  url.searchParams.set("maxResults", String(MAX_VIDEOS));
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `search API failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: { title?: string };
    }>;
  };

  const titles = new Map<string, string>();
  for (const item of json.items ?? []) {
    const id = item.id?.videoId;
    const title = item.snippet?.title ?? null;
    if (id) titles.set(id, title ?? id);
  }
  return titles;
}

interface VideoAnalyticsRow {
  day: string;
  videoId: string;
  views: number;
  avgViewDurationSeconds: number;
  subsGained: number;
}

// One Analytics call per channel with dimensions=day,video -- returns all
// videos in the channel that had activity in the window.
async function fetchVideoAnalytics(
  accessToken: string,
  channelId: string,
  startDate: string,
  endDate: string,
): Promise<VideoAnalyticsRow[]> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", `channel==${channelId}`);
  url.searchParams.set("dimensions", "day,video");
  url.searchParams.set("metrics", YT_VIDEO_METRICS);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
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
  const vi = idx("video");
  const viewsi = idx("views");
  const avdi = idx("averageViewDuration");
  const sgi = idx("subscribersGained");
  const sli = idx("subscribersLost");

  const num = (row: (string | number | null)[], i: number): number => {
    if (i < 0) return 0;
    const v = row[i];
    return typeof v === "number" ? v : 0;
  };

  const out: VideoAnalyticsRow[] = [];
  for (const row of json.rows ?? []) {
    if (di < 0 || vi < 0) continue;
    const day = row[di];
    const videoId = row[vi];
    if (typeof day !== "string" || typeof videoId !== "string") continue;
    out.push({
      day,
      videoId,
      views: num(row, viewsi),
      avgViewDurationSeconds: Math.round(num(row, avdi)),
      subsGained: num(row, sgi) - num(row, sli),
    });
  }
  return out;
}

async function pullPlatformVideos(
  env: Bindings,
  tenantId: string,
  platform: TenantPlatform,
  window: { startDate: string; endDate: string },
  apiKey: string,
): Promise<{
  platform: string;
  channel_id: string;
  videos_found: number;
  rows_written: number;
  error?: string;
}> {
  const channelId = platform.channel_id ?? "";
  const credentialsKey = platform.credentials_key;
  const base = { platform: platform.id, channel_id: channelId };

  if (!channelId || !credentialsKey) {
    return {
      ...base,
      videos_found: 0,
      rows_written: 0,
      error: !channelId ? "missing channel_id" : "missing credentials_key",
    };
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(env, credentialsKey);
  } catch (err) {
    return {
      ...base,
      videos_found: 0,
      rows_written: 0,
      error: `token_refresh: ${errMsg(err)}`,
    };
  }

  let videoTitles: Map<string, string>;
  try {
    videoTitles = await fetchVideoList(apiKey, channelId);
  } catch (err) {
    return {
      ...base,
      videos_found: 0,
      rows_written: 0,
      error: `video_list: ${errMsg(err)}`,
    };
  }

  if (videoTitles.size === 0) {
    console.log("video_pull_empty", { platform: platform.id, channelId });
    return { ...base, videos_found: 0, rows_written: 0 };
  }

  let analyticsRows: VideoAnalyticsRow[];
  try {
    analyticsRows = await fetchVideoAnalytics(
      accessToken,
      channelId,
      window.startDate,
      window.endDate,
    );
  } catch (err) {
    return {
      ...base,
      videos_found: videoTitles.size,
      rows_written: 0,
      error: `analytics: ${errMsg(err)}`,
    };
  }

  // Filter to only videos we know about from the search list, then batch write.
  const knownRows = analyticsRows.filter((r) => videoTitles.has(r.videoId));
  if (knownRows.length === 0) {
    return { ...base, videos_found: videoTitles.size, rows_written: 0 };
  }

  try {
    const stmts = knownRows.map((row) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO video_snapshots
           (id, tenant_id, video_id, video_title, snapshot_date,
            lifetime_views, ctr, avg_view_duration_seconds, subs_gained)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        tenantId,
        row.videoId,
        videoTitles.get(row.videoId) ?? row.videoId,
        row.day,
        row.views,
        null, // Path Z: CTR computed at query time
        row.avgViewDurationSeconds,
        row.subsGained,
      ),
    );
    await env.DB.batch(stmts);
  } catch (err) {
    return {
      ...base,
      videos_found: videoTitles.size,
      rows_written: 0,
      error: `db_write: ${errMsg(err)}`,
    };
  }

  return {
    ...base,
    videos_found: videoTitles.size,
    rows_written: knownRows.length,
  };
}

export async function runVideoPull(env: Bindings): Promise<VideoPullResult> {
  const tenantId = env.TENANT_ID;
  const window = computePullWindow();
  const platformResults: VideoPullResult["platforms"] = [];

  try {
    const apiKey = await getYouTubeApiKey(env);
    if (!apiKey) throw new Error("KV missing: youtube_api_key");

    const config = await loadTenantConfig(env, tenantId);
    const ytPlatforms = config.platforms.filter(
      (p) => p.source === "youtube_api",
    );

    const results = await Promise.allSettled(
      ytPlatforms.map((p) =>
        pullPlatformVideos(env, tenantId, p, window, apiKey),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const p = ytPlatforms[i];
      if (r.status === "fulfilled") {
        platformResults.push(r.value);
      } else {
        platformResults.push({
          platform: p.id,
          channel_id: p.channel_id ?? "",
          videos_found: 0,
          rows_written: 0,
          error: errMsg(r.reason),
        });
      }
    }
  } catch (err) {
    platformResults.push({
      platform: "<setup>",
      channel_id: "",
      videos_found: 0,
      rows_written: 0,
      error: errMsg(err),
    });
  }

  // Audit log always written.
  try {
    const totalVideos = platformResults.reduce((s, r) => s + r.videos_found, 0);
    const totalRows = platformResults.reduce((s, r) => s + r.rows_written, 0);
    await env.DB.prepare(
      `INSERT INTO watchman_audit_log
         (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'cron_video_pull', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        JSON.stringify({
          window_start: window.startDate,
          window_end: window.endDate,
          videos_found: totalVideos,
          rows_written: totalRows,
          platforms: platformResults,
        }),
      )
      .run();
  } catch (err) {
    console.error("cron_video_pull: audit write failed", errMsg(err));
  }

  return {
    window_start: window.startDate,
    window_end: window.endDate,
    platforms: platformResults,
  };
}
