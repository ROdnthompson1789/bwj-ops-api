// Facebook Page + Instagram analytics cron (Item 8).
//
// Exits cleanly when KV keys are absent -- build now, activate after Meta approval.
// Pattern mirrors cron-youtube.ts (Rule 6).
//
// To activate: run scripts/activate-facebook-instagram.ps1 after Meta approves
// the app and issues a long-lived Page Access Token.

import type { Bindings } from "../lib/types";

const PULL_WINDOW_DAYS = 7;

function computeWindow(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (PULL_WINDOW_DAYS - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Meta Insights API returns an array of metric objects.
// Each object has: { name, period, values: [{value, end_time}], ... }
interface MetaInsightMetric {
  name: string;
  values: Array<{ value: number; end_time: string }>;
}

interface MetaInsightResponse {
  data?: MetaInsightMetric[];
  error?: { message: string; code: number };
}

function endTimeToDate(endTime: string): string {
  // end_time is ISO timestamp for end of period; subtract 1 day to get the day label
  const d = new Date(endTime);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchPageInsights(
  pageId: string,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<
  Array<{
    date: string;
    views: number;
    newFollowers: number;
    reach: number;
  }>
> {
  const url = new URL(
    `https://graph.facebook.com/v19.0/${pageId}/insights`,
  );
  url.searchParams.set(
    "metric",
    "page_views_total,page_fan_adds_unique,page_impressions_unique",
  );
  url.searchParams.set("period", "day");
  url.searchParams.set("since", startDate);
  url.searchParams.set("until", endDate);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = (await res.json()) as MetaInsightResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `Facebook insights failed: ${json.error?.message ?? `HTTP ${res.status}`}`,
    );
  }

  const byDate = new Map<
    string,
    { views: number; newFollowers: number; reach: number }
  >();
  for (const metric of json.data ?? []) {
    for (const entry of metric.values) {
      const date = endTimeToDate(entry.end_time);
      const row = byDate.get(date) ?? { views: 0, newFollowers: 0, reach: 0 };
      if (metric.name === "page_views_total") row.views = entry.value;
      if (metric.name === "page_fan_adds_unique") row.newFollowers = entry.value;
      if (metric.name === "page_impressions_unique") row.reach = entry.value;
      byDate.set(date, row);
    }
  }

  return Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }));
}

async function fetchInstagramInsights(
  igAccountId: string,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<
  Array<{
    date: string;
    views: number;
    reach: number;
    activityCount: number;
  }>
> {
  const url = new URL(
    `https://graph.facebook.com/v19.0/${igAccountId}/insights`,
  );
  url.searchParams.set(
    "metric",
    "impressions,reach,profile_views",
  );
  url.searchParams.set("period", "day");
  url.searchParams.set("since", startDate);
  url.searchParams.set("until", endDate);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = (await res.json()) as MetaInsightResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `Instagram insights failed: ${json.error?.message ?? `HTTP ${res.status}`}`,
    );
  }

  const byDate = new Map<
    string,
    { views: number; reach: number; activityCount: number }
  >();
  for (const metric of json.data ?? []) {
    for (const entry of metric.values) {
      const date = endTimeToDate(entry.end_time);
      const row = byDate.get(date) ?? {
        views: 0,
        reach: 0,
        activityCount: 0,
      };
      if (metric.name === "impressions") row.views = entry.value;
      if (metric.name === "reach") row.reach = entry.value;
      if (metric.name === "profile_views") row.activityCount = entry.value;
      byDate.set(date, row);
    }
  }

  return Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }));
}

export async function runSocialPull(env: Bindings): Promise<void> {
  const tenantId = env.TENANT_ID;
  const window = computeWindow();

  // Check KV keys. Missing = skip cleanly.
  const [appId, pageToken, pageId, igAccountId] = await Promise.all([
    env.SECRETS.get("facebook_oauth_app_id"),
    env.SECRETS.get("facebook_page_access_token"),
    env.SECRETS.get("facebook_page_id"),
    env.SECRETS.get("instagram_business_account_id"),
  ]);

  if (!appId || !pageToken || !pageId || !igAccountId) {
    console.log("social_pull_skipped", {
      reason: "kv_keys_missing",
      missing: [
        !appId && "facebook_oauth_app_id",
        !pageToken && "facebook_page_access_token",
        !pageId && "facebook_page_id",
        !igAccountId && "instagram_business_account_id",
      ].filter(Boolean),
    });
    try {
      await env.DB.prepare(
        `INSERT INTO watchman_audit_log
           (id, tenant_id, event_type, user_action)
         VALUES (?, ?, 'cron_social_skipped', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          tenantId,
          JSON.stringify({ reason: "kv_keys_missing" }),
        )
        .run();
    } catch {
      // Audit write failure is non-fatal
    }
    return;
  }

  const succeeded: string[] = [];
  const failed: Array<{ platform: string; error: string }> = [];

  // Facebook pull
  try {
    const fbRows = await fetchPageInsights(
      pageId,
      pageToken,
      window.startDate,
      window.endDate,
    );
    if (fbRows.length > 0) {
      const stmts = fbRows.map((day) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO daily_snapshots
             (id, tenant_id, platform, snapshot_date,
              views, followers, new_followers_today, ctr,
              watch_time_minutes, reach, activity_count, source)
           VALUES (?, ?, 'facebook', ?, ?, ?, ?, ?, ?, ?, ?, 'api')`,
        ).bind(
          crypto.randomUUID(),
          tenantId,
          day.date,
          day.views,
          null,
          day.newFollowers,
          null,
          null,
          day.reach,
          null,
        ),
      );
      await env.DB.batch(stmts);
    }
    succeeded.push("facebook");
  } catch (err) {
    failed.push({ platform: "facebook", error: errMsg(err) });
  }

  // Instagram pull
  try {
    const igRows = await fetchInstagramInsights(
      igAccountId,
      pageToken,
      window.startDate,
      window.endDate,
    );
    if (igRows.length > 0) {
      const stmts = igRows.map((day) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO daily_snapshots
             (id, tenant_id, platform, snapshot_date,
              views, followers, new_followers_today, ctr,
              watch_time_minutes, reach, activity_count, source)
           VALUES (?, ?, 'instagram', ?, ?, ?, ?, ?, ?, ?, ?, 'api')`,
        ).bind(
          crypto.randomUUID(),
          tenantId,
          day.date,
          day.views,
          null,
          null,
          null,
          null,
          day.reach,
          day.activityCount,
        ),
      );
      await env.DB.batch(stmts);
    }
    succeeded.push("instagram");
  } catch (err) {
    failed.push({ platform: "instagram", error: errMsg(err) });
  }

  // Audit log
  try {
    await env.DB.prepare(
      `INSERT INTO watchman_audit_log
         (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'cron_social_pull', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        JSON.stringify({
          window_start: window.startDate,
          window_end: window.endDate,
          succeeded,
          failed,
        }),
      )
      .run();
  } catch (err) {
    console.error("cron_social_pull: audit write failed", errMsg(err));
  }
}
