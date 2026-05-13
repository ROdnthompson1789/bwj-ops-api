// TikTok analytics cron (Item 9).
//
// Exits cleanly when KV keys are absent -- build now, activate after TikTok approval.
// Uses TikTok Login Kit (v2) to pull current account totals.
//
// Note: TikTok Login Kit does not expose historical daily views via an API
// accessible to regular Login Kit scope. This cron writes a single row per day
// with the current lifetime totals. Per-day delta reporting requires Research API
// scope (separate approval). If Research API is later approved, extend this cron.
//
// To activate: run scripts/activate-tiktok.ps1 after TikTok OAuth is complete.

import type { Bindings } from "../lib/types";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refreshTikTokToken(
  _env: Bindings,
  clientKey: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_key: clientKey,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `TikTok token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as {
    data?: { access_token: string; expires_in: number };
    error?: { code: string; message: string };
  };

  if (!json.data?.access_token) {
    throw new Error(
      `TikTok token refresh: no access_token in response. Error: ${json.error?.message ?? "unknown"}`,
    );
  }

  const expiresIn = json.data.expires_in ?? 86400;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return { accessToken: json.data.access_token, expiresAt };
}

interface TikTokUserInfo {
  follower_count?: number;
  video_views_count?: number;
  likes_count?: number;
}

async function fetchTikTokUserInfo(
  accessToken: string,
): Promise<TikTokUserInfo> {
  const res = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=follower_count,video_views_count,likes_count",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `TikTok user info failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as {
    data?: { user?: TikTokUserInfo };
    error?: { code: string; message: string };
  };

  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(`TikTok user info error: ${json.error.message}`);
  }

  return json.data?.user ?? {};
}

export async function runTikTokPull(env: Bindings): Promise<void> {
  const tenantId = env.TENANT_ID;
  const today = new Date().toISOString().slice(0, 10);

  // Check KV keys. Missing = skip cleanly.
  const [clientKey, clientSecret, accessToken, expiresAt, refreshToken, openId] =
    await Promise.all([
      env.SECRETS.get("tiktok_oauth_client_key"),
      env.SECRETS.get("tiktok_oauth_client_secret"),
      env.SECRETS.get("tiktok_oauth_access_token"),
      env.SECRETS.get("tiktok_oauth_access_token_expires_at"),
      env.SECRETS.get("tiktok_oauth_refresh_token"),
      env.SECRETS.get("tiktok_open_id"),
    ]);

  if (!clientKey || !clientSecret || !accessToken || !refreshToken || !openId) {
    console.log("tiktok_pull_skipped", { reason: "kv_keys_missing" });
    try {
      await env.DB.prepare(
        `INSERT INTO watchman_audit_log
           (id, tenant_id, event_type, user_action)
         VALUES (?, ?, 'cron_tiktok_skipped', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          tenantId,
          JSON.stringify({ reason: "kv_keys_missing" }),
        )
        .run();
    } catch {
      // Non-fatal
    }
    return;
  }

  let currentToken = accessToken;

  // Refresh token if expired or about to expire
  if (
    !expiresAt ||
    new Date(expiresAt).getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS
  ) {
    try {
      const refreshed = await refreshTikTokToken(
        env,
        clientKey,
        clientSecret,
        refreshToken,
      );
      currentToken = refreshed.accessToken;
      // Store new token and expiry in KV
      await Promise.all([
        env.SECRETS.put(
          "tiktok_oauth_access_token",
          refreshed.accessToken,
        ),
        env.SECRETS.put(
          "tiktok_oauth_access_token_expires_at",
          refreshed.expiresAt,
        ),
      ]);
    } catch (err) {
      console.error("tiktok_pull: token refresh failed", errMsg(err));
      try {
        await env.DB.prepare(
          `INSERT INTO watchman_audit_log
             (id, tenant_id, event_type, user_action)
           VALUES (?, ?, 'cron_tiktok_pull', ?)`,
        )
          .bind(
            crypto.randomUUID(),
            tenantId,
            JSON.stringify({ error: "token_refresh_failed", detail: errMsg(err) }),
          )
          .run();
      } catch {
        // Non-fatal
      }
      return;
    }
  }

  try {
    const userInfo = await fetchTikTokUserInfo(currentToken);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO daily_snapshots
         (id, tenant_id, platform, snapshot_date,
          views, followers, new_followers_today, ctr,
          watch_time_minutes, reach, activity_count, source)
       VALUES (?, ?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?, 'api')`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        today,
        userInfo.video_views_count ?? null, // lifetime total, not daily delta
        userInfo.follower_count ?? null,
        null,
        null,
        null,
        null,
        null,
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO watchman_audit_log
         (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'cron_tiktok_pull', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        JSON.stringify({
          date: today,
          open_id: openId,
          follower_count: userInfo.follower_count,
          video_views_count: userInfo.video_views_count,
        }),
      )
      .run();
  } catch (err) {
    console.error("tiktok_pull: data pull failed", errMsg(err));
    try {
      await env.DB.prepare(
        `INSERT INTO watchman_audit_log
           (id, tenant_id, event_type, user_action)
         VALUES (?, ?, 'cron_tiktok_pull', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          tenantId,
          JSON.stringify({ error: errMsg(err) }),
        )
        .run();
    } catch {
      // Non-fatal
    }
  }
}
