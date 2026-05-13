# activate-facebook-instagram.ps1
# Run this AFTER Meta approves the app and you have a long-lived Page Access Token.
# DO NOT run until Meta business verification + app review is confirmed.

$NS = 'bc0bebb969fa47cfaeeeda85a8c0997d'

Write-Host "Facebook/Instagram activation" -ForegroundColor Cyan
Write-Host "Have your Facebook App credentials, Page Access Token, and account IDs ready."
Write-Host ""

$appId = Read-Host "Facebook App ID (from developers.facebook.com)"
$appSecret = Read-Host "Facebook App Secret"
$pageToken = Read-Host "Facebook Page Access Token (long-lived, 60-day or permanent)"
$pageId = Read-Host "Facebook Page ID (numeric)"
$igAccountId = Read-Host "Instagram Business Account ID (numeric)"

Write-Host ""
Write-Host "Writing to KV..." -ForegroundColor Yellow

npx wrangler kv key put --namespace-id=$NS "facebook_oauth_app_id" $appId --remote
npx wrangler kv key put --namespace-id=$NS "facebook_oauth_app_secret" $appSecret --remote
npx wrangler kv key put --namespace-id=$NS "facebook_page_access_token" $pageToken --remote
npx wrangler kv key put --namespace-id=$NS "facebook_page_id" $pageId --remote
npx wrangler kv key put --namespace-id=$NS "instagram_business_account_id" $igAccountId --remote

Write-Host ""
Write-Host "Done. The social cron will activate at the next 11:30 UTC run." -ForegroundColor Green
Write-Host "Check the audit log after the first run: /watchman/audit"
