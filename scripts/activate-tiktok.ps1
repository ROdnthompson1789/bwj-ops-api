# activate-tiktok.ps1
# Run this AFTER TikTok approves the Login Kit app and you complete the OAuth flow.
# DO NOT run until TikTok app review is confirmed.

$NS = 'bc0bebb969fa47cfaeeeda85a8c0997d'

Write-Host "TikTok activation" -ForegroundColor Cyan
Write-Host "Complete the OAuth flow in TikTok Developer portal first to get tokens."
Write-Host ""

$clientKey = Read-Host "TikTok Client Key (from developers.tiktok.com)"
$clientSecret = Read-Host "TikTok Client Secret"
$accessToken = Read-Host "TikTok Access Token (from OAuth callback)"
$refreshToken = Read-Host "TikTok Refresh Token (from OAuth callback)"
$openId = Read-Host "TikTok Open ID (user identifier from OAuth callback)"

# Set expires_at to 23 hours from now (TikTok access tokens last 24h)
$expiresAt = (Get-Date).AddHours(23).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

Write-Host ""
Write-Host "Writing to KV..." -ForegroundColor Yellow

npx wrangler kv key put --namespace-id=$NS "tiktok_oauth_client_key" $clientKey --remote
npx wrangler kv key put --namespace-id=$NS "tiktok_oauth_client_secret" $clientSecret --remote
npx wrangler kv key put --namespace-id=$NS "tiktok_oauth_access_token" $accessToken --remote
npx wrangler kv key put --namespace-id=$NS "tiktok_oauth_refresh_token" $refreshToken --remote
npx wrangler kv key put --namespace-id=$NS "tiktok_open_id" $openId --remote
npx wrangler kv key put --namespace-id=$NS "tiktok_oauth_access_token_expires_at" $expiresAt --remote

Write-Host ""
Write-Host "Done. The TikTok cron will activate at the next 11:45 UTC run." -ForegroundColor Green
Write-Host "The cron auto-refreshes the token before each pull."
Write-Host "Check the audit log after the first run: /watchman/audit"
