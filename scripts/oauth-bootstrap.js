// One-shot OAuth bootstrap for the YouTube Analytics integration.
// Reads the Desktop-app OAuth credentials from 03-credentials, runs the
// authorization-code flow against Google (OOB redirect), verifies the
// resulting access_token works against YouTube Analytics, and stashes
// client_id / client_secret / refresh_token into bwj-ops-secrets KV.
//
// Run manually (interactive — stdin prompt for the auth code):
//   node scripts/oauth-bootstrap.js
//
// NOTE on OOB (urn:ietf:wg:oauth:2.0:oob):
// Google deprecated OOB for new OAuth clients in early 2022. Most legacy
// clients also had their OOB support disabled. If the consent screen shows
// "Error 400: invalid_request" or refuses to issue a code, Ctrl-C and tell
// Rodney — we'll switch to a loopback-redirect flow (separate decision).

"use strict";

const fs = require("fs");
const readline = require("readline");
const { spawnSync } = require("child_process");

const CREDS_PATH =
  "C:\\Users\\Black\\BWJ Operations Hub\\03-credentials\\bwj-watchman-oauth.json";
const KV_NAMESPACE_ID = "bc0bebb969fa47cfaeeeda85a8c0997d";
const BWJ_MAIN_CHANNEL_ID = "UCNSNQagBxGlndO2YSU-5BxQ";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const redact = (s) =>
  s ? `${s.slice(0, 8)}...(${s.length} chars)` : "<empty>";

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    const summary = JSON.stringify(json);
    throw new Error(`token exchange failed (HTTP ${res.status}): ${summary}`);
  }
  return json;
}

async function testAnalyticsCall(accessToken) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(today.getUTCDate() - 7);

  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", `channel==${BWJ_MAIN_CHANNEL_ID}`);
  url.searchParams.set("startDate", fmtDate(weekAgo));
  url.searchParams.set("endDate", fmtDate(yesterday));
  url.searchParams.set("metrics", "views");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) {
    const summary = JSON.stringify(json);
    throw new Error(
      `analytics test call failed (HTTP ${res.status}): ${summary}`,
    );
  }
  return json;
}

function kvPut(key, value) {
  // spawnSync with shell:true on Windows lets us call `wrangler` without
  // hard-coding the .cmd path. Args go through Node's Windows arg-quoting,
  // which is safe for Google OAuth values (alphanumeric + dash + dot).
  const result = spawnSync(
    "wrangler",
    [
      "kv",
      "key",
      "put",
      `--namespace-id=${KV_NAMESPACE_ID}`,
      "--remote",
      key,
      value,
    ],
    { encoding: "utf-8", shell: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler kv put failed for ${key} (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
}

async function main() {
  console.log("=== Step 1 of 5: Load OAuth client credentials ===");
  const raw = fs.readFileSync(CREDS_PATH, "utf-8");
  const json = JSON.parse(raw);
  const installed = json.installed || json.web;
  if (!installed || !installed.client_id || !installed.client_secret) {
    throw new Error(
      "creds JSON missing installed.client_id or installed.client_secret",
    );
  }
  const clientId = installed.client_id;
  const clientSecret = installed.client_secret;
  console.log(`  client_id     = ${redact(clientId)}`);
  console.log(`  client_secret = ${redact(clientSecret)}`);

  console.log("\n=== Step 2 of 5: Build authorization URL ===");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  console.log("\nOpen this URL in a browser, approve, copy the code shown:\n");
  console.log(authUrl.toString());
  console.log(
    "\nIf Google shows 'Error 400: invalid_request' or refuses to display a code, Ctrl-C and report — the OOB flow is no longer accepted for this client.\n",
  );

  const code = await prompt("Paste the authorization code here: ");
  if (!code) throw new Error("no authorization code provided");

  console.log("\n=== Step 3 of 5: Exchange code for tokens ===");
  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
  if (!tokens.refresh_token) {
    throw new Error(
      "token response did not include refresh_token. prompt=consent should guarantee one. Aborting before any KV writes.",
    );
  }
  const { access_token, refresh_token, expires_in, scope } = tokens;
  console.log(`  access_token  = ${redact(access_token)} (expires in ${expires_in}s)`);
  console.log(`  refresh_token = ${redact(refresh_token)}`);
  console.log(`  granted scope = ${scope}`);

  console.log("\n=== Step 4 of 5: Verify with a real YouTube Analytics call ===");
  const analytics = await testAnalyticsCall(access_token);
  const rowCount = Array.isArray(analytics.rows) ? analytics.rows.length : 0;
  console.log(`  endpoint: youtubeanalytics.googleapis.com/v2/reports`);
  console.log(`  channel:  ${BWJ_MAIN_CHANNEL_ID} (BWJ Main)`);
  console.log(`  window:   last 7 days ending yesterday (UTC)`);
  console.log(`  rows:     ${rowCount}`);
  if (rowCount > 0) {
    console.log(`  sample:   ${JSON.stringify(analytics.rows[0])}`);
  } else {
    console.log("  (channel returned zero views in the window — auth worked, data just empty)");
  }

  console.log("\n=== Step 5 of 5: Stash credentials in bwj-ops-secrets KV ===");
  kvPut("youtube_oauth_client_id", clientId);
  console.log(`  PUT youtube_oauth_client_id     -> ${redact(clientId)}`);
  kvPut("youtube_oauth_client_secret", clientSecret);
  console.log(`  PUT youtube_oauth_client_secret -> ${redact(clientSecret)}`);
  kvPut("youtube_oauth_refresh_token", refresh_token);
  console.log(`  PUT youtube_oauth_refresh_token -> ${redact(refresh_token)}`);

  console.log("\nSuccess. Three keys live in bwj-ops-secrets KV.");
  console.log("Source credentials file left in place at:");
  console.log(`  ${CREDS_PATH}`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
