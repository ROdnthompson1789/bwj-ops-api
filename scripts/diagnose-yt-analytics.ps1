# One-shot diagnostic: reproduce the cron's YouTube Analytics call by hand
# for both BWJ Main and BWJ Shorts, so we can see whether the API itself is
# returning zeros or the cron is parsing a real response incorrectly.
#
# Reads-only against KV (3 keys per channel). No KV writes. No D1 writes.
# Prints API response bodies; redacts tokens.

$ErrorActionPreference = "Stop"
$KV_NS  = 'bc0bebb969fa47cfaeeeda85a8c0997d'
$MAIN_CH = 'UCNSNQagBxGlndO2YSU-5BxQ'
$SH_CH   = 'UCkxXRS46IRX3sXTrCrrpXpw'
$METRICS = 'views,subscribersGained,subscribersLost,estimatedMinutesWatched,averageViewDuration'

function KvGet([string]$key) {
  $v = (wrangler kv key get --namespace-id=$KV_NS --remote $key 2>$null | Out-String).Trim()
  return $v
}

function Refresh([string]$cid, [string]$csc, [string]$rt) {
  $body = "client_id=$cid&client_secret=$csc&refresh_token=$rt&grant_type=refresh_token"
  $r = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method POST -ContentType "application/x-www-form-urlencoded" -Body $body
  return $r.access_token
}

function Analytics([string]$at, [string]$ids, [string]$start, [string]$end, [string]$dim = '') {
  $url = "https://youtubeanalytics.googleapis.com/v2/reports?ids=$ids&startDate=$start&endDate=$end&metrics=$METRICS"
  if ($dim) { $url += "&dimensions=$dim" }
  try {
    $r = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $at" } -UseBasicParsing -ErrorAction Stop
    return @{ status = $r.StatusCode; body = $r.Content }
  } catch {
    $st  = $_.Exception.Response.StatusCode.value__
    $rs  = $_.Exception.Response.GetResponseStream()
    $rdr = New-Object System.IO.StreamReader($rs)
    return @{ status = $st; body = $rdr.ReadToEnd() }
  }
}

Write-Host "=== KV key presence (length only) ==="
$mCid = KvGet 'youtube_oauth_client_id'
$mCsc = KvGet 'youtube_oauth_client_secret'
$mRt  = KvGet 'youtube_oauth_refresh_token'
$sCid = KvGet 'youtube_oauth_shorts_client_id'
$sCsc = KvGet 'youtube_oauth_shorts_client_secret'
$sRt  = KvGet 'youtube_oauth_shorts_refresh_token'
"  main   client_id={0,3} client_secret={1,3} refresh_token={2,4}" -f $mCid.Length, $mCsc.Length, $mRt.Length
"  shorts client_id={0,3} client_secret={1,3} refresh_token={2,4}" -f $sCid.Length, $sCsc.Length, $sRt.Length

if ($mRt.Length -eq 0 -or $sRt.Length -eq 0) { Write-Host "ABORT -- missing refresh token"; exit 1 }

Write-Host "`n=== Refreshing access tokens ==="
$mAt = Refresh $mCid $mCsc $mRt
$sAt = Refresh $sCid $sCsc $sRt
"  main   access_token length={0}" -f $mAt.Length
"  shorts access_token length={0}" -f $sAt.Length

$DATE = '2026-05-10'

Write-Host "`n=== Test A: cron-equivalent -- channel==<id>, single day, no dimensions ==="
Write-Host "--- BWJ Main ---"
(Analytics $mAt "channel==$MAIN_CH" $DATE $DATE).body
Write-Host "--- BWJ Shorts ---"
(Analytics $sAt "channel==$SH_CH"   $DATE $DATE).body

Write-Host "`n=== Test B: channel==MINE instead of channel==<id> ==="
Write-Host "--- BWJ Main MINE ---"
(Analytics $mAt "channel==MINE" $DATE $DATE).body
Write-Host "--- BWJ Shorts MINE ---"
(Analytics $sAt "channel==MINE" $DATE $DATE).body

Write-Host "`n=== Test C: 7-day window with day dimension (proves data is there) ==="
$START = (Get-Date).ToUniversalTime().AddDays(-9).ToString('yyyy-MM-dd')
$END   = (Get-Date).ToUniversalTime().AddDays(-2).ToString('yyyy-MM-dd')
Write-Host "  window: $START -> $END"
Write-Host "--- BWJ Main MINE+day ---"
(Analytics $mAt "channel==MINE" $START $END 'day').body
Write-Host "--- BWJ Shorts MINE+day ---"
(Analytics $sAt "channel==MINE" $START $END 'day').body
