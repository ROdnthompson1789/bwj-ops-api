import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import { requireAuth } from "../lib/auth";
import {
  PLATFORM_IDS,
  DATE_RE,
  isPlatformId,
  resolveTenantId,
  type DailySnapshotRow,
  type LatestFollowersRow,
  type PlatformId,
  type RollupRow,
  type TenantConfig,
  type WatchmanAuditRow,
} from "../lib/watchman";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

// Writable KPI columns on daily_snapshots. snake_case keys map 1:1 to columns.
const KPI_FIELDS = [
  "views",
  "followers",
  "new_followers_today",
  "ctr",
  "watch_time_minutes",
  "reach",
  "activity_count",
] as const;

// GET /watchman/config
app.get("/watchman/config", async (c) => {
  const tenantId = resolveTenantId(c);
  const row = await c.env.DB.prepare(
    "SELECT config_json FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<{ config_json: string }>();
  if (!row) {
    return c.json({ error: "tenant_not_found", tenant_id: tenantId }, 404);
  }
  let config: TenantConfig;
  try {
    config = JSON.parse(row.config_json) as TenantConfig;
  } catch {
    return c.json({ error: "config_json_invalid" }, 500);
  }
  return c.json({ tenant_id: tenantId, config });
});

// GET /watchman/snapshot/today
// TODO(v2): read tenant timezone from config, use TZ-aware datetime functions. Currently UTC.
app.get("/watchman/snapshot/today", async (c) => {
  const tenantId = resolveTenantId(c);

  const [todayRes, rollupRes, followersRes] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT * FROM daily_snapshots
       WHERE tenant_id = ? AND snapshot_date = date('now')`,
    ).bind(tenantId),
    c.env.DB.prepare(
      `SELECT
         platform,
         COALESCE(SUM(CASE WHEN snapshot_date >= date('now', '-6 days') THEN views ELSE 0 END), 0) AS views_7d,
         COALESCE(SUM(views), 0) AS views_28d,
         COALESCE(SUM(CASE WHEN snapshot_date >= date('now', '-6 days') THEN new_followers_today ELSE 0 END), 0) AS new_followers_7d,
         COALESCE(SUM(new_followers_today), 0) AS new_followers_28d
       FROM daily_snapshots
       WHERE tenant_id = ? AND snapshot_date >= date('now', '-27 days')
       GROUP BY platform`,
    ).bind(tenantId),
    c.env.DB.prepare(
      `SELECT ds.platform, ds.followers
       FROM daily_snapshots ds
       JOIN (
         SELECT platform, MAX(snapshot_date) AS max_date
         FROM daily_snapshots
         WHERE tenant_id = ? AND followers IS NOT NULL
         GROUP BY platform
       ) latest ON ds.platform = latest.platform AND ds.snapshot_date = latest.max_date
       WHERE ds.tenant_id = ? AND ds.followers IS NOT NULL
       GROUP BY ds.platform`,
    ).bind(tenantId, tenantId),
  ]);

  const todayRows = (todayRes.results ?? []) as DailySnapshotRow[];
  const rollupRows = (rollupRes.results ?? []) as RollupRow[];
  const followerRows = (followersRes.results ?? []) as LatestFollowersRow[];

  const byPlatformToday = new Map(todayRows.map((r) => [r.platform, r]));
  const byPlatformRollup = new Map(rollupRows.map((r) => [r.platform, r]));
  const byPlatformFollowers = new Map(followerRows.map((r) => [r.platform, r.followers]));

  const platforms = PLATFORM_IDS.map((id) => {
    const rollup = byPlatformRollup.get(id);
    return {
      platform: id,
      today: byPlatformToday.get(id) ?? null,
      views_7d: rollup?.views_7d ?? 0,
      views_28d: rollup?.views_28d ?? 0,
      new_followers_7d: rollup?.new_followers_7d ?? 0,
      new_followers_28d: rollup?.new_followers_28d ?? 0,
      followers: byPlatformFollowers.get(id) ?? null,
    };
  });

  const snapshotDateRow = await c.env.DB.prepare(
    "SELECT date('now') AS d",
  ).first<{ d: string }>();

  return c.json({
    snapshot_date: snapshotDateRow?.d ?? new Date().toISOString().slice(0, 10),
    tenant_id: tenantId,
    platforms,
    flags: [],
  });
});

// GET /watchman/snapshots/:platform?from=&to=
app.get("/watchman/snapshots/:platform", async (c) => {
  const tenantId = resolveTenantId(c);
  const platform = c.req.param("platform");
  if (!isPlatformId(platform)) {
    return c.json(
      { error: "invalid_platform", allowed: PLATFORM_IDS },
      400,
    );
  }
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (from && !DATE_RE.test(from)) {
    return c.json({ error: "invalid_from_date", expected: "YYYY-MM-DD" }, 400);
  }
  if (to && !DATE_RE.test(to)) {
    return c.json({ error: "invalid_to_date", expected: "YYYY-MM-DD" }, 400);
  }
  if (from && to && from > to) {
    return c.json({ error: "from_after_to", from, to }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM daily_snapshots
     WHERE tenant_id = ?
       AND platform = ?
       AND snapshot_date >= COALESCE(?, date('now', '-27 days'))
       AND snapshot_date <= COALESCE(?, date('now'))
     ORDER BY snapshot_date ASC, created_at ASC`,
  )
    .bind(tenantId, platform, from || null, to || null)
    .all<DailySnapshotRow>();

  return c.json({
    tenant_id: tenantId,
    platform,
    from: from || null,
    to: to || null,
    count: results.length,
    snapshots: results,
  });
});

// POST /watchman/sync/manual
// TODO(v2): read tenant timezone from config, use TZ-aware datetime functions. Currently UTC.
app.post("/watchman/sync/manual", async (c) => {
  const tenantId = resolveTenantId(c);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!isPlatformId(body.platform)) {
    return c.json(
      { error: "invalid_platform", allowed: PLATFORM_IDS },
      400,
    );
  }
  if (
    typeof body.snapshot_date !== "string" ||
    !DATE_RE.test(body.snapshot_date)
  ) {
    return c.json(
      { error: "invalid_snapshot_date", expected: "YYYY-MM-DD" },
      400,
    );
  }

  const kpiValues: Record<(typeof KPI_FIELDS)[number], number | null> = {
    views: null,
    followers: null,
    new_followers_today: null,
    ctr: null,
    watch_time_minutes: null,
    reach: null,
    activity_count: null,
  };
  let anyKpi = false;
  for (const field of KPI_FIELDS) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return c.json({ error: "invalid_kpi_value", field }, 400);
    }
    kpiValues[field] = v;
    anyKpi = true;
  }
  if (!anyKpi) {
    return c.json({ error: "no_kpi_values", allowed: KPI_FIELDS }, 400);
  }

  const snapshotId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const userAction = JSON.stringify(body);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO daily_snapshots
         (id, tenant_id, platform, snapshot_date,
          views, followers, new_followers_today, ctr,
          watch_time_minutes, reach, activity_count, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    ).bind(
      snapshotId,
      tenantId,
      body.platform,
      body.snapshot_date,
      kpiValues.views,
      kpiValues.followers,
      kpiValues.new_followers_today,
      kpiValues.ctr,
      kpiValues.watch_time_minutes,
      kpiValues.reach,
      kpiValues.activity_count,
    ),
    c.env.DB.prepare(
      `INSERT INTO watchman_audit_log
         (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'manual_sync', ?)`,
    ).bind(auditId, tenantId, userAction),
  ]);

  const inserted = await c.env.DB.prepare(
    "SELECT * FROM daily_snapshots WHERE id = ?",
  )
    .bind(snapshotId)
    .first<DailySnapshotRow>();

  return c.json({ snapshot: inserted, audit_id: auditId }, 201);
});

// ---------------------------------------------------------------------------
// Phase 2 — constellation + master chart endpoints (Build Plan Steps 2.1, 2.3)
// ---------------------------------------------------------------------------

interface LatestVideoRow {
  video_id: string;
  video_title: string | null;
  snapshot_date: string;
  lifetime_views: number | null;
  ctr: number | null;
  avg_view_duration_seconds: number | null;
  subs_gained: number | null;
}

interface PlatformViewsRow {
  platform: string;
  views_28d: number;
}

interface ClipBridgeRow {
  source_video_id: string;
  platform: string;
  views_sum: number;
}

interface ClipDetailRow {
  clip_id: string;
  source_video_id: string;
  platform: string;
  views_sum: number;
  hook_formula: string | null;
  voice_formula: string | null;
  cast_member: string | null;
  content_gap_term: string | null;
}

const CHANNEL_VIDEO_LIMIT = 24;

// GET /watchman/constellation/channel
app.get("/watchman/constellation/channel", async (c) => {
  const tenantId = resolveTenantId(c);

  const tenantRow = await c.env.DB.prepare(
    "SELECT config_json FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<{ config_json: string }>();
  if (!tenantRow) {
    return c.json({ error: "tenant_not_found", tenant_id: tenantId }, 404);
  }
  let config: TenantConfig;
  try {
    config = JSON.parse(tenantRow.config_json) as TenantConfig;
  } catch {
    return c.json({ error: "config_json_invalid" }, 500);
  }

  const [videoRes, platformRes, clipRes] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT vs.video_id, vs.video_title, vs.snapshot_date,
              vs.lifetime_views, vs.ctr, vs.avg_view_duration_seconds, vs.subs_gained
       FROM video_snapshots vs
       INNER JOIN (
         SELECT video_id, MAX(snapshot_date) AS max_date
         FROM video_snapshots
         WHERE tenant_id = ?
         GROUP BY video_id
       ) latest ON latest.video_id = vs.video_id AND latest.max_date = vs.snapshot_date
       WHERE vs.tenant_id = ?
       ORDER BY COALESCE(vs.lifetime_views, 0) DESC
       LIMIT ?`,
    ).bind(tenantId, tenantId, CHANNEL_VIDEO_LIMIT),
    c.env.DB.prepare(
      `SELECT platform, COALESCE(SUM(views), 0) AS views_28d
       FROM daily_snapshots
       WHERE tenant_id = ? AND snapshot_date >= date('now', '-27 days')
       GROUP BY platform`,
    ).bind(tenantId),
    c.env.DB.prepare(
      `SELECT source_video_id, platform, COALESCE(SUM(views), 0) AS views_sum
       FROM clip_snapshots
       WHERE tenant_id = ? AND snapshot_date >= date('now', '-27 days')
       GROUP BY source_video_id, platform`,
    ).bind(tenantId),
  ]);

  const videos = (videoRes.results ?? []) as LatestVideoRow[];
  const platforms = (platformRes.results ?? []) as PlatformViewsRow[];
  const clipBridges = (clipRes.results ?? []) as ClipBridgeRow[];

  const platformConfig = new Map(config.platforms.map((p) => [p.id, p]));
  const platformsWithActivity = new Set(platforms.map((p) => p.platform));
  for (const p of config.platforms) platformsWithActivity.add(p.id);

  const channelTotal = platforms.reduce((sum, p) => sum + (p.views_28d ?? 0), 0);

  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];

  nodes.push({
    id: `channel:${tenantId}`,
    type: "channel",
    label: config.brand.dashboard_name,
    val: channelTotal,
    accent_color: config.brand.accent_color,
  });

  for (const v of videos) {
    const nodeId = `video:${v.video_id}`;
    nodes.push({
      id: nodeId,
      type: "video",
      label: v.video_title ?? v.video_id,
      val: v.lifetime_views ?? 0,
      ctr: v.ctr,
      avg_view_duration_seconds: v.avg_view_duration_seconds,
      subs_gained: v.subs_gained,
      last_snapshot: v.snapshot_date,
    });
    edges.push({
      source: `channel:${tenantId}`,
      target: nodeId,
      type: "channel_video",
      value: v.lifetime_views ?? 0,
    });
  }

  for (const platformId of platformsWithActivity) {
    const cfg = platformConfig.get(platformId as PlatformId);
    const stats = platforms.find((p) => p.platform === platformId);
    const nodeId = `platform:${platformId}`;
    nodes.push({
      id: nodeId,
      type: "platform",
      label: cfg?.label ?? platformId,
      val: stats?.views_28d ?? 0,
      color_start: cfg?.color_start ?? null,
      color_end: cfg?.color_end ?? null,
    });
    edges.push({
      source: `channel:${tenantId}`,
      target: nodeId,
      type: "channel_platform",
      value: stats?.views_28d ?? 0,
    });
  }

  const videoIds = new Set(videos.map((v) => v.video_id));
  for (const bridge of clipBridges) {
    if (!videoIds.has(bridge.source_video_id)) continue;
    if (!platformsWithActivity.has(bridge.platform)) continue;
    edges.push({
      source: `video:${bridge.source_video_id}`,
      target: `platform:${bridge.platform}`,
      type: "video_platform",
      value: bridge.views_sum,
    });
  }

  return c.json({
    tenant_id: tenantId,
    generated_at: new Date().toISOString(),
    counts: {
      videos: videos.length,
      platforms: platformsWithActivity.size,
      edges: edges.length,
    },
    nodes,
    edges,
  });
});

// GET /watchman/constellation/video/:id
app.get("/watchman/constellation/video/:id", async (c) => {
  const tenantId = resolveTenantId(c);
  const videoId = c.req.param("id");
  if (!videoId || videoId.length > 64) {
    return c.json({ error: "invalid_video_id" }, 400);
  }

  const tenantRow = await c.env.DB.prepare(
    "SELECT config_json FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<{ config_json: string }>();
  if (!tenantRow) {
    return c.json({ error: "tenant_not_found", tenant_id: tenantId }, 404);
  }
  let config: TenantConfig;
  try {
    config = JSON.parse(tenantRow.config_json) as TenantConfig;
  } catch {
    return c.json({ error: "config_json_invalid" }, 500);
  }

  const [videoRes, clipRes] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT vs.video_id, vs.video_title, vs.snapshot_date,
              vs.lifetime_views, vs.ctr, vs.avg_view_duration_seconds, vs.subs_gained
       FROM video_snapshots vs
       WHERE vs.tenant_id = ? AND vs.video_id = ?
       ORDER BY vs.snapshot_date DESC
       LIMIT 1`,
    ).bind(tenantId, videoId),
    c.env.DB.prepare(
      `SELECT clip_id, source_video_id, platform,
              COALESCE(SUM(views), 0) AS views_sum,
              MAX(hook_formula) AS hook_formula,
              MAX(voice_formula) AS voice_formula,
              MAX(cast_member) AS cast_member,
              MAX(content_gap_term) AS content_gap_term
       FROM clip_snapshots
       WHERE tenant_id = ? AND source_video_id = ?
       GROUP BY clip_id, source_video_id, platform`,
    ).bind(tenantId, videoId),
  ]);

  const videoRow = (videoRes.results ?? [])[0] as LatestVideoRow | undefined;
  if (!videoRow) {
    return c.json({ error: "video_not_found", video_id: videoId }, 404);
  }
  const clips = (clipRes.results ?? []) as ClipDetailRow[];

  const platformConfig = new Map(config.platforms.map((p) => [p.id, p]));
  const platformTotals = new Map<string, number>();
  const hookTotals = new Map<string, number>();
  const voiceTotals = new Map<string, number>();
  const castTotals = new Map<string, number>();
  const gapTotals = new Map<string, number>();
  for (const clip of clips) {
    platformTotals.set(clip.platform, (platformTotals.get(clip.platform) ?? 0) + clip.views_sum);
    if (clip.hook_formula) hookTotals.set(clip.hook_formula, (hookTotals.get(clip.hook_formula) ?? 0) + clip.views_sum);
    if (clip.voice_formula) voiceTotals.set(clip.voice_formula, (voiceTotals.get(clip.voice_formula) ?? 0) + clip.views_sum);
    if (clip.cast_member) castTotals.set(clip.cast_member, (castTotals.get(clip.cast_member) ?? 0) + clip.views_sum);
    if (clip.content_gap_term) gapTotals.set(clip.content_gap_term, (gapTotals.get(clip.content_gap_term) ?? 0) + clip.views_sum);
  }

  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];

  const videoNodeId = `video:${videoRow.video_id}`;
  nodes.push({
    id: videoNodeId,
    type: "video",
    label: videoRow.video_title ?? videoRow.video_id,
    val: videoRow.lifetime_views ?? 0,
    ctr: videoRow.ctr,
    avg_view_duration_seconds: videoRow.avg_view_duration_seconds,
    subs_gained: videoRow.subs_gained,
    last_snapshot: videoRow.snapshot_date,
  });

  for (const clip of clips) {
    const clipNodeId = `clip:${clip.clip_id}`;
    nodes.push({
      id: clipNodeId,
      type: "clip",
      label: clip.clip_id,
      val: clip.views_sum,
      platform: clip.platform,
      hook_formula: clip.hook_formula,
      voice_formula: clip.voice_formula,
      cast_member: clip.cast_member,
      content_gap_term: clip.content_gap_term,
    });
    edges.push({
      source: videoNodeId,
      target: clipNodeId,
      type: "video_clip",
      value: clip.views_sum,
    });

    const platformNodeId = `platform:${clip.platform}`;
    edges.push({
      source: clipNodeId,
      target: platformNodeId,
      type: "clip_platform",
      value: clip.views_sum,
    });
    if (clip.hook_formula) {
      edges.push({ source: clipNodeId, target: `hook:${clip.hook_formula}`, type: "clip_hook" });
    }
    if (clip.voice_formula) {
      edges.push({ source: clipNodeId, target: `voice:${clip.voice_formula}`, type: "clip_voice" });
    }
    if (clip.cast_member) {
      edges.push({ source: clipNodeId, target: `cast:${clip.cast_member}`, type: "clip_cast" });
    }
    if (clip.content_gap_term) {
      edges.push({ source: clipNodeId, target: `gap:${clip.content_gap_term}`, type: "clip_gap" });
    }
  }

  for (const [platformId, val] of platformTotals) {
    const cfg = platformConfig.get(platformId as PlatformId);
    nodes.push({
      id: `platform:${platformId}`,
      type: "platform",
      label: cfg?.label ?? platformId,
      val,
      color_start: cfg?.color_start ?? null,
      color_end: cfg?.color_end ?? null,
    });
  }
  for (const [hook, val] of hookTotals) {
    nodes.push({ id: `hook:${hook}`, type: "hook", label: hook, val });
  }
  for (const [voice, val] of voiceTotals) {
    nodes.push({ id: `voice:${voice}`, type: "voice", label: voice, val });
  }
  for (const [cast, val] of castTotals) {
    nodes.push({ id: `cast:${cast}`, type: "cast", label: cast, val });
  }
  for (const [gap, val] of gapTotals) {
    nodes.push({ id: `gap:${gap}`, type: "content_gap", label: gap, val });
  }

  return c.json({
    tenant_id: tenantId,
    video_id: videoId,
    generated_at: new Date().toISOString(),
    counts: {
      clips: clips.length,
      platforms: platformTotals.size,
      hooks: hookTotals.size,
      voices: voiceTotals.size,
      cast: castTotals.size,
      content_gaps: gapTotals.size,
      edges: edges.length,
    },
    nodes,
    edges,
  });
});

interface DailyByPlatformRow {
  snapshot_date: string;
  platform: string;
  views: number;
}

// GET /watchman/chart/master?days=14
app.get("/watchman/chart/master", async (c) => {
  const tenantId = resolveTenantId(c);
  const daysRaw = Number(c.req.query("days") ?? 14);
  if (!Number.isInteger(daysRaw) || daysRaw < 1 || daysRaw > 90) {
    return c.json({ error: "invalid_days", allowed: "1..90" }, 400);
  }
  const days = daysRaw;
  // Inclusive window: today - (days-1) ... today.
  const offset = `-${days - 1} days`;

  const { results } = await c.env.DB.prepare(
    `SELECT snapshot_date, platform, COALESCE(SUM(views), 0) AS views
     FROM daily_snapshots
     WHERE tenant_id = ? AND snapshot_date >= date('now', ?)
     GROUP BY snapshot_date, platform
     ORDER BY snapshot_date ASC`,
  )
    .bind(tenantId, offset)
    .all<DailyByPlatformRow>();

  const dateRow = await c.env.DB.prepare(
    `SELECT date('now') AS today, date('now', ?) AS first`,
  )
    .bind(offset)
    .first<{ today: string; first: string }>();
  const todayStr = dateRow?.today ?? new Date().toISOString().slice(0, 10);

  type PlatformBucket = { [K in PlatformId]: number };
  const blank = (): PlatformBucket =>
    Object.fromEntries(PLATFORM_IDS.map((id) => [id, 0])) as PlatformBucket;

  const byDate = new Map<string, PlatformBucket>();
  for (const row of results) {
    if (!byDate.has(row.snapshot_date)) byDate.set(row.snapshot_date, blank());
    if (isPlatformId(row.platform)) {
      byDate.get(row.snapshot_date)![row.platform] = row.views;
    }
  }

  // Fill in missing dates so the chart has a continuous series.
  const series: Array<{
    date: string;
    platforms: PlatformBucket;
    total: number;
    flag: boolean;
  }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(`${todayStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const platforms = byDate.get(dateStr) ?? blank();
    const total = PLATFORM_IDS.reduce((sum, id) => sum + platforms[id], 0);
    series.push({ date: dateStr, platforms, total, flag: false });
  }

  // Server-side flag: an anomaly day where total is >= 2x or <= 0.5x the
  // trailing 7-day average of preceding days. Per packet rule 7 (Path Z),
  // we DO NOT use CTR-based flags here — that's Phase 2 per-video work.
  const trailing: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const day = series[i];
    if (trailing.length >= 3) {
      const window = trailing.slice(-7);
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      if (avg > 0 && (day.total >= avg * 2 || day.total <= avg * 0.5)) {
        day.flag = true;
      }
    }
    trailing.push(day.total);
  }

  return c.json({
    tenant_id: tenantId,
    days,
    first_date: dateRow?.first ?? null,
    last_date: todayStr,
    series,
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — sentinel-flag endpoints (Build Plan Step 3.6)
// ---------------------------------------------------------------------------

interface SentinelFlagRow {
  id: string;
  tenant_id: string;
  threshold_id: string;
  fired_at: string;
  resolved_at: string | null;
  resolution: string | null;
  title: string;
  body: string | null;
  action_due_at: string | null;
  related_platform: string | null;
  related_video_id: string | null;
  related_brand_id: number | null;
}

const RESOLUTION_VALUES = ["approved", "dismissed", "snoozed"] as const;
type Resolution = (typeof RESOLUTION_VALUES)[number];
const isResolution = (v: unknown): v is Resolution =>
  typeof v === "string" && (RESOLUTION_VALUES as readonly string[]).includes(v);

// Sort priority: action_due_at NULLs last, then ascending fired_at.
// The packet says "sorted by priority then fired_at" — until thresholds
// carry a numeric priority column, treat action_due_at NOT NULL as the
// "do this first" signal.
app.get("/watchman/flags", async (c) => {
  const tenantId = resolveTenantId(c);
  const status = c.req.query("status") ?? "open";
  if (status !== "open" && status !== "resolved" && status !== "all") {
    return c.json({ error: "invalid_status", allowed: ["open", "resolved", "all"] }, 400);
  }

  let where = "tenant_id = ?";
  if (status === "open") where += " AND resolution IS NULL";
  if (status === "resolved") where += " AND resolution IS NOT NULL";

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM sentinel_flags
     WHERE ${where}
     ORDER BY
       CASE WHEN action_due_at IS NULL THEN 1 ELSE 0 END ASC,
       action_due_at ASC,
       fired_at ASC`,
  )
    .bind(tenantId)
    .all<SentinelFlagRow>();

  return c.json({
    tenant_id: tenantId,
    status,
    count: results.length,
    flags: results,
  });
});

app.post("/watchman/flags/:id/resolve", async (c) => {
  const tenantId = resolveTenantId(c);
  const flagId = c.req.param("id");
  if (!flagId) return c.json({ error: "invalid_flag_id" }, 400);

  let body: {
    resolution?: unknown;
    notes?: unknown;
    snooze_until?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!isResolution(body.resolution)) {
    return c.json(
      { error: "invalid_resolution", allowed: RESOLUTION_VALUES },
      400,
    );
  }
  const resolution: Resolution = body.resolution;
  const notes =
    typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const snoozeUntil =
    typeof body.snooze_until === "string" && body.snooze_until.trim()
      ? body.snooze_until.trim()
      : null;
  if (resolution === "snoozed" && !snoozeUntil) {
    return c.json({ error: "snooze_until_required" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT * FROM sentinel_flags WHERE id = ? AND tenant_id = ?",
  )
    .bind(flagId, tenantId)
    .first<SentinelFlagRow>();
  if (!existing) {
    return c.json({ error: "flag_not_found" }, 404);
  }
  if (existing.resolution) {
    return c.json(
      {
        error: "flag_already_resolved",
        resolution: existing.resolution,
        resolved_at: existing.resolved_at,
      },
      409,
    );
  }

  const auditId = crypto.randomUUID();
  const userAction = JSON.stringify({ resolution, notes, snooze_until: snoozeUntil });

  if (resolution === "snoozed") {
    // Snooze = keep the flag open but defer its action_due_at. Don't write
    // resolved_at/resolution since the decision is still pending.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE sentinel_flags SET action_due_at = ? WHERE id = ?`,
      ).bind(snoozeUntil, flagId),
      c.env.DB.prepare(
        `INSERT INTO watchman_audit_log
           (id, tenant_id, event_type, user_action, related_flag_id, notes)
         VALUES (?, ?, 'flag_snoozed', ?, ?, ?)`,
      ).bind(auditId, tenantId, userAction, flagId, notes),
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE sentinel_flags
         SET resolution = ?, resolved_at = datetime('now')
         WHERE id = ?`,
      ).bind(resolution, flagId),
      c.env.DB.prepare(
        `INSERT INTO watchman_audit_log
           (id, tenant_id, event_type, user_action, related_flag_id, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        auditId,
        tenantId,
        resolution === "approved" ? "flag_approved" : "flag_dismissed",
        userAction,
        flagId,
        notes,
      ),
    ]);
  }

  const updated = await c.env.DB.prepare(
    "SELECT * FROM sentinel_flags WHERE id = ?",
  )
    .bind(flagId)
    .first<SentinelFlagRow>();

  return c.json({ flag: updated, audit_id: auditId, resolution });
});

// GET /watchman/audit?from=&to=&limit=
app.get("/watchman/audit", async (c) => {
  const tenantId = resolveTenantId(c);
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const limitRaw = Number(c.req.query("limit") ?? 100);
  if (from && !DATE_RE.test(from)) {
    return c.json({ error: "invalid_from_date", expected: "YYYY-MM-DD" }, 400);
  }
  if (to && !DATE_RE.test(to)) {
    return c.json({ error: "invalid_to_date", expected: "YYYY-MM-DD" }, 400);
  }
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 1000) {
    return c.json({ error: "invalid_limit", allowed: "1..1000" }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM watchman_audit_log
     WHERE tenant_id = ?
       AND (? IS NULL OR date(event_at) >= ?)
       AND (? IS NULL OR date(event_at) <= ?)
     ORDER BY event_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(
      tenantId,
      from || null,
      from || null,
      to || null,
      to || null,
      limitRaw,
    )
    .all<WatchmanAuditRow>();

  return c.json({
    tenant_id: tenantId,
    from: from || null,
    to: to || null,
    count: results.length,
    entries: results,
  });
});

export default app;
