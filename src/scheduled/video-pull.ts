// Per-video YouTube Data API cron -- Phase 2 Step 2.2.
//
// Populates video_snapshots so the constellation graph has data.
// Runs at 20 11 * * * (between threshold eval at 11:15 and social pull at 11:30).
//
// Uses YouTube Data API v3 videos?part=statistics (not Analytics API).
// Analytics API does not support per-video dimensions in channel reports.
// Data API returns lifetime view counts in one batch call per channel.
// Only needs the API key -- no OAuth required.
//
// Rule 6: reads platform list from tenant config, works for any tenant.
// Path Z: ctr column is left null -- computed at query time from per-video data.

import type { Bindings } from "../lib/types";
import { getYouTubeApiKey } from "../lib/kv";
import type { TenantConfig, TenantPlatform } from "../lib/watchman";

const MAX_VIDEOS = 50;

export interface VideoPullResult {
  snapshot_date: string;
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

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
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

interface VideoStats {
  videoId: string;
  viewCount: number;
}

// Batch-fetch statistics for all video IDs in one Data API call.
async function fetchVideoStats(
  apiKey: string,
  videoIds: string[],
): Promise<Map<string, VideoStats>> {
  if (videoIds.length === 0) return new Map();

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `videos API failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    items?: Array<{
      id?: string;
      statistics?: { viewCount?: string };
    }>;
  };

  const out = new Map<string, VideoStats>();
  for (const item of json.items ?? []) {
    if (!item.id) continue;
    out.set(item.id, {
      videoId: item.id,
      viewCount: parseInt(item.statistics?.viewCount ?? "0", 10) || 0,
    });
  }
  return out;
}

async function pullPlatformVideos(
  env: Bindings,
  tenantId: string,
  platform: TenantPlatform,
  snapshotDate: string,
  apiKey: string,
): Promise<{
  platform: string;
  channel_id: string;
  videos_found: number;
  rows_written: number;
  error?: string;
}> {
  const channelId = platform.channel_id ?? "";
  const base = { platform: platform.id, channel_id: channelId };

  if (!channelId) {
    return { ...base, videos_found: 0, rows_written: 0, error: "missing channel_id" };
  }

  let videoTitles: Map<string, string>;
  try {
    videoTitles = await fetchVideoList(apiKey, channelId);
  } catch (err) {
    return { ...base, videos_found: 0, rows_written: 0, error: `video_list: ${errMsg(err)}` };
  }

  if (videoTitles.size === 0) {
    console.log("video_pull_empty", { platform: platform.id, channelId });
    return { ...base, videos_found: 0, rows_written: 0 };
  }

  let statsMap: Map<string, VideoStats>;
  try {
    statsMap = await fetchVideoStats(apiKey, [...videoTitles.keys()]);
  } catch (err) {
    return { ...base, videos_found: videoTitles.size, rows_written: 0, error: `video_stats: ${errMsg(err)}` };
  }

  const rows = [...statsMap.values()].filter((s) => videoTitles.has(s.videoId));
  if (rows.length === 0) {
    return { ...base, videos_found: videoTitles.size, rows_written: 0 };
  }

  try {
    const stmts = rows.map((row) =>
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
        snapshotDate,
        row.viewCount,
        null, // Path Z: CTR computed at query time
        null, // Data API does not provide avg view duration
        0,
      ),
    );
    await env.DB.batch(stmts);
  } catch (err) {
    return { ...base, videos_found: videoTitles.size, rows_written: 0, error: `db_write: ${errMsg(err)}` };
  }

  return { ...base, videos_found: videoTitles.size, rows_written: rows.length };
}

export async function runVideoPull(env: Bindings): Promise<VideoPullResult> {
  const tenantId = env.TENANT_ID;
  const snapshotDate = todayUTC();
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
        pullPlatformVideos(env, tenantId, p, snapshotDate, apiKey),
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
          snapshot_date: snapshotDate,
          videos_found: totalVideos,
          rows_written: totalRows,
          platforms: platformResults,
        }),
      )
      .run();
  } catch (err) {
    console.error("cron_video_pull: audit write failed", errMsg(err));
  }

  return { snapshot_date: snapshotDate, platforms: platformResults };
}
