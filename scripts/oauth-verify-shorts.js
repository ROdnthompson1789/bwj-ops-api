// Read-only verification: the YouTube OAuth refresh token from KV can pull
// analytics for the Blackwater Outdoor Shorts channel.
// No KV writes. No interactive prompts. Safe to re-run.
//
//   node scripts/oauth-verify-shorts.js

"use strict";

const { spawnSync } = require("child_process");

const KV_NAMESPACE_ID = "bc0bebb969fa47cfaeeeda85a8c0997d";
const BWJ_SHORTS_CHANNEL_ID = "UCkxXRS46IRX3sXTrCrrpXpw";

const redact = (s) =>
  s ? `${s.slice(0, 8)}...(${s.length} chars)` : "<empty>";

function kvGet(key) {
  const result = spawnSync(
    "wrangler",
    [
      "kv",
      "key",
      "get",
      `--namespace-id=${KV_NAMESPACE_ID}`,
      "--remote",
      key,
    ],
    { encoding: "utf-8", shell: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler kv get failed for ${key} (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout || "").trim();
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
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
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `refresh failed (HTTP ${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function pullAnalytics(accessToken, channelId) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(today.getUTCDate() - 7);

  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", `channel==${channelId}`);
  url.searchParams.set("startDate", fmtDate(weekAgo));
  url.searchParams.set("endDate", fmtDate(yesterday));
  url.searchParams.set("metrics", "views");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, body: json };
}

function explainAnalyticsError(status, body) {
  const reason =
    body?.error?.errors?.[0]?.reason ||
    body?.error?.status ||
    "unknown";
  const message = body?.error?.message || "(no message)";

  if (status === 401) {
    return `HTTP 401 (${reason}): the access token was rejected. Likely the refresh-token exchange returned a token without the yt-analytics scope, or the token is expired. ${message}`;
  }
  if (status === 403 && /forbidden/i.test(reason)) {
    return `HTTP 403 forbidden (${reason}): the OAuth user does not have analytics access to channel ${BWJ_SHORTS_CHANNEL_ID}. This typically means the channel is owned by a different Google account than the one that authorized the bootstrap script. ${message}`;
  }
  if (status === 403) {
    return `HTTP 403 (${reason}): API call rejected. Common causes: YouTube Analytics API not enabled in the bwj-operations Cloud project, or the OAuth consent screen does not include the yt-analytics.readonly scope. ${message}`;
  }
  if (status === 404 || /notFound/i.test(reason)) {
    return `HTTP ${status} (${reason}): channel ${BWJ_SHORTS_CHANNEL_ID} not found. Either the channel ID is wrong or the OAuth user cannot see it. ${message}`;
  }
  return `HTTP ${status} (${reason}): ${message}`;
}

async function main() {
  console.log("=== Step 1 of 3: Read OAuth credentials from KV ===");
  const clientId = kvGet("youtube_oauth_client_id");
  const clientSecret = kvGet("youtube_oauth_client_secret");
  const refreshToken = kvGet("youtube_oauth_refresh_token");
  console.log(`  client_id     = ${redact(clientId)}`);
  console.log(`  client_secret = ${redact(clientSecret)}`);
  console.log(`  refresh_token = ${redact(refreshToken)}`);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("one or more KV values were empty");
  }

  console.log("\n=== Step 2 of 3: Refresh access token ===");
  const tokens = await refreshAccessToken(clientId, clientSecret, refreshToken);
  const { access_token, expires_in, scope } = tokens;
  console.log(`  access_token  = ${redact(access_token)} (expires in ${expires_in}s)`);
  console.log(`  scope         = ${scope}`);
  if (!/yt-analytics/.test(scope || "")) {
    console.warn(
      "  WARNING: yt-analytics.readonly not in granted scope. Call will likely fail.",
    );
  }

  console.log("\n=== Step 3 of 3: Pull Shorts analytics ===");
  console.log(`  channel: ${BWJ_SHORTS_CHANNEL_ID} (Blackwater Outdoor Shorts)`);
  console.log(`  window:  last 7 days ending yesterday (UTC)`);
  const result = await pullAnalytics(access_token, BWJ_SHORTS_CHANNEL_ID);
  if (!result.ok) {
    console.error("\nFAILED:");
    console.error("  " + explainAnalyticsError(result.status, result.body));
    console.error("  Raw response: " + JSON.stringify(result.body));
    process.exit(1);
  }

  const rows = Array.isArray(result.body.rows) ? result.body.rows : [];
  const views = rows.length > 0 ? rows[0][0] : 0;
  console.log(`  rows:    ${rows.length}`);
  console.log(`  views:   ${views}`);
  console.log("\nSuccess. The refresh token works for both BWJ Main and Shorts.");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
