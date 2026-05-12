# Smoke tests for /watchman/* endpoints (Build Plan Step 1.5).
# Run: pwsh ./tests/smoke-watchman.ps1   (or PowerShell 5.1)
# Stops on first failure. Writes 1 daily_snapshots row + 2 watchman_audit_log rows.
# Cleanup SQL is printed at the end (NOT auto-run).

$ErrorActionPreference = "Stop"

$script:url = "https://bwj-ops-api.rodneythompson.workers.dev"
$script:total = 0
$script:passed = 0
$script:failed = 0
$script:createdSnapshotIds = @()
$script:createdAuditIds = @()

Write-Host "Pulling bearer token from KV..." -ForegroundColor Cyan
$script:token = (wrangler kv key get --namespace-id=bc0bebb969fa47cfaeeeda85a8c0997d "api_access_token" --remote 2>&1 | Out-String).Trim()
if ($script:token.Length -lt 16) { throw "Failed to fetch api_access_token from KV" }
$script:authHeaders = @{ "Authorization" = "Bearer $($script:token)" }

function Test-Endpoint {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        [object] $Body = $null,
        [Parameter(Mandatory)] [int] $ExpectedStatus,
        [hashtable] $HeadersOverride = $null,
        [scriptblock] $Validate = $null
    )

    $h = if ($null -ne $HeadersOverride) { $HeadersOverride } else { $script:authHeaders }

    $params = @{
        Uri             = "$($script:url)$Path"
        Method          = $Method
        Headers         = $h
        UseBasicParsing = $true
        ErrorAction     = "Stop"
    }

    if ($null -ne $Body) {
        if ($Body -is [string]) {
            $params.Body = $Body
        } else {
            $params.Body = ($Body | ConvertTo-Json -Compress -Depth 10)
        }
        $params.ContentType = "application/json"
    }

    $status = 0
    $bodyText = ""
    try {
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode
        $bodyText = $r.Content
    } catch {
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($null -ne $stream) {
                    if ($stream.CanSeek) { $stream.Position = 0 }
                    $reader = New-Object System.IO.StreamReader($stream)
                    $bodyText = $reader.ReadToEnd()
                }
            } catch {
                $bodyText = "<could not read body: $($_.Exception.Message)>"
            }
        } else {
            $status = -1
            $bodyText = $_.Exception.Message
        }
    }

    $parsed = $null
    $trimmed = $bodyText.Trim()
    if ($trimmed.StartsWith("{") -or $trimmed.StartsWith("[")) {
        try { $parsed = $bodyText | ConvertFrom-Json } catch { $parsed = $null }
    }

    $statusOk = ($status -eq $ExpectedStatus)
    $validateMsg = ""
    $validateOk = $true
    if ($Validate -and $statusOk) {
        try {
            $vres = & $Validate $parsed
            if ($vres -is [bool]) {
                $validateOk = $vres
                if (-not $validateOk) { $validateMsg = "validation returned false" }
            } elseif ($null -eq $vres -or $vres -eq "") {
                $validateOk = $true
            } else {
                $validateMsg = "$vres"
                $validateOk = $false
            }
        } catch {
            $validateOk = $false
            $validateMsg = "validate threw: $($_.Exception.Message)"
        }
    }

    $script:total++

    if ($statusOk -and $validateOk) {
        $script:passed++
        Write-Host ("  PASS  [{0}] {1}" -f $status, $Name) -ForegroundColor Green
        return $parsed
    }

    $script:failed++
    Write-Host ("  FAIL  expected {0} got {1}: {2}" -f $ExpectedStatus, $status, $Name) -ForegroundColor Red
    if ($validateMsg) { Write-Host "        $validateMsg" -ForegroundColor Red }
    $preview = if ($bodyText.Length -gt 400) { $bodyText.Substring(0, 400) + "..." } else { $bodyText }
    Write-Host "        body: $preview" -ForegroundColor DarkRed
    throw "Test failed: $Name"
}

try {
    Write-Host ""
    Write-Host "=== GET /watchman/config ===" -ForegroundColor Cyan

    $cfg = Test-Endpoint -Name "config: happy path" -Method GET -Path "/watchman/config" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.tenant_id -ne "bwj") { return "tenant_id mismatch: $($r.tenant_id)" }
        if ($r.config.name -ne "Blackwater Outdoor Journeys") { return "config.name mismatch: $($r.config.name)" }
        $true
    }

    Test-Endpoint -Name "config: missing Authorization" -Method GET -Path "/watchman/config" -ExpectedStatus 401 -HeadersOverride @{} -Validate {
        param($r); if ($r.error -ne "missing_bearer_token") { return "expected missing_bearer_token, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "config: wrong token" -Method GET -Path "/watchman/config" -ExpectedStatus 401 -HeadersOverride @{ "Authorization" = "Bearer wrong_token_xxxxx" } -Validate {
        param($r); if ($r.error -ne "invalid_token") { return "expected invalid_token, got $($r.error)" }; $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== GET /watchman/snapshot/today ===" -ForegroundColor Cyan

    Test-Endpoint -Name "snapshot/today: happy path + shape" -Method GET -Path "/watchman/snapshot/today" -ExpectedStatus 200 -Validate {
        param($r)
        if (-not $r.snapshot_date) { return "missing snapshot_date" }
        if (-not ($r.flags -is [array])) { return "flags is not an array" }
        if ($r.flags.Count -ne 0) { return "expected flags=[] in Phase 1, got Count=$($r.flags.Count)" }
        $expectedIds = @("bwj_main", "bwj_shorts", "tiktok", "instagram", "facebook", "skool")
        if ($r.platforms.Count -ne 6) { return "expected 6 platforms, got $($r.platforms.Count)" }
        $seen = @{}
        foreach ($p in $r.platforms) {
            if ($seen.ContainsKey($p.platform)) { return "platform $($p.platform) appears twice" }
            $seen[$p.platform] = $true
            if ($expectedIds -notcontains $p.platform) { return "unexpected platform id: $($p.platform)" }
        }
        foreach ($id in $expectedIds) {
            if (-not $seen.ContainsKey($id)) { return "missing platform: $id" }
        }
        # With no data yet, today should be null per platform and rollups should be 0
        foreach ($p in $r.platforms) {
            if ($null -ne $p.today) { return "expected today=null for $($p.platform) before sync, got non-null" }
            if ($p.views_7d -ne 0 -or $p.views_28d -ne 0) { return "expected 0 rollups for $($p.platform), got 7d=$($p.views_7d) 28d=$($p.views_28d)" }
        }
        $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== GET /watchman/snapshots/:platform ===" -ForegroundColor Cyan

    Test-Endpoint -Name "snapshots/tiktok: happy path empty" -Method GET -Path "/watchman/snapshots/tiktok" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.platform -ne "tiktok") { return "platform mismatch" }
        if ($r.count -ne 0) { return "expected count=0 pre-sync, got $($r.count)" }
        $true
    } | Out-Null

    Test-Endpoint -Name "snapshots: invalid platform" -Method GET -Path "/watchman/snapshots/youtube" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_platform") { return "expected invalid_platform, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "snapshots: invalid from date" -Method GET -Path "/watchman/snapshots/tiktok?from=2026/05/01" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_from_date") { return "expected invalid_from_date, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "snapshots: invalid to date" -Method GET -Path "/watchman/snapshots/tiktok?to=bad" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_to_date") { return "expected invalid_to_date, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "snapshots: from after to" -Method GET -Path "/watchman/snapshots/tiktok?from=2026-05-11&to=2026-05-01" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "from_after_to") { return "expected from_after_to, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "snapshots: valid range count=0" -Method GET -Path "/watchman/snapshots/tiktok?from=2026-05-01&to=2026-05-11" -ExpectedStatus 200 -Validate {
        param($r); if ($r.count -ne 0) { return "expected 0, got $($r.count)" }; $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== POST /watchman/sync/manual ===" -ForegroundColor Cyan

    $sync1 = Test-Endpoint -Name "sync/manual: happy path #1 (views=1234)" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "tiktok"; snapshot_date = "2026-05-11"; views = 1234 } -ExpectedStatus 201 -Validate {
        param($r)
        if (-not $r.snapshot) { return "no snapshot in response" }
        if ($r.snapshot.platform -ne "tiktok") { return "platform mismatch" }
        if ($r.snapshot.views -ne 1234) { return "views mismatch: $($r.snapshot.views)" }
        if ($r.snapshot.source -ne "manual") { return "source mismatch: $($r.snapshot.source)" }
        if (-not $r.audit_id) { return "missing audit_id" }
        $true
    }
    $script:createdSnapshotIds += $sync1.snapshot.id
    $script:createdAuditIds += $sync1.audit_id

    $sync2 = Test-Endpoint -Name "sync/manual: re-sync same key (views=1500, expect REPLACE)" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "tiktok"; snapshot_date = "2026-05-11"; views = 1500 } -ExpectedStatus 201 -Validate {
        param($r)
        if ($r.snapshot.views -ne 1500) { return "views mismatch: $($r.snapshot.views)" }
        $true
    }
    $script:createdSnapshotIds += $sync2.snapshot.id
    $script:createdAuditIds += $sync2.audit_id

    # Verify daily_snapshots count for (tiktok, 2026-05-11) stayed at 1 (REPLACE not INSERT)
    Test-Endpoint -Name "sync/manual: verify REPLACE kept count=1" -Method GET -Path "/watchman/snapshots/tiktok?from=2026-05-11&to=2026-05-11" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.count -ne 1) { return "expected count=1 after REPLACE, got $($r.count)" }
        if ($r.snapshots[0].views -ne 1500) { return "expected views=1500 (latest), got $($r.snapshots[0].views)" }
        $true
    } | Out-Null

    Test-Endpoint -Name "sync/manual: invalid platform" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "youtube"; snapshot_date = "2026-05-11"; views = 100 } -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_platform") { return "expected invalid_platform, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "sync/manual: invalid date" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "tiktok"; snapshot_date = "may 11"; views = 100 } -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_snapshot_date") { return "expected invalid_snapshot_date, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "sync/manual: no KPI values" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "tiktok"; snapshot_date = "2026-05-11" } -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "no_kpi_values") { return "expected no_kpi_values, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "sync/manual: string where number expected" -Method POST -Path "/watchman/sync/manual" `
        -Body @{ platform = "tiktok"; snapshot_date = "2026-05-11"; views = "hello" } -ExpectedStatus 400 -Validate {
        param($r)
        if ($r.error -ne "invalid_kpi_value") { return "expected invalid_kpi_value, got $($r.error)" }
        if ($r.field -ne "views") { return "expected field=views, got $($r.field)" }
        $true
    } | Out-Null

    Test-Endpoint -Name "sync/manual: malformed JSON body" -Method POST -Path "/watchman/sync/manual" `
        -Body '{not valid json' -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_json") { return "expected invalid_json, got $($r.error)" }; $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== GET /watchman/audit ===" -ForegroundColor Cyan

    Test-Endpoint -Name "audit: happy path, has 2 manual_sync entries with captured user_action" -Method GET -Path "/watchman/audit" -ExpectedStatus 200 -Validate {
        param($r)
        $syncEntries = @($r.entries | Where-Object { $_.event_type -eq "manual_sync" })
        if ($syncEntries.Count -lt 2) { return "expected >=2 manual_sync entries, got $($syncEntries.Count)" }
        # Both test entries should have user_action JSON containing our test payload
        $matched = 0
        foreach ($e in $syncEntries) {
            if (-not $e.user_action) { continue }
            try {
                $ua = $e.user_action | ConvertFrom-Json
                if ($ua.platform -eq "tiktok" -and $ua.snapshot_date -eq "2026-05-11" -and ($ua.views -eq 1234 -or $ua.views -eq 1500)) {
                    $matched++
                }
            } catch { }
        }
        if ($matched -lt 2) { return "expected 2 audit entries with parseable user_action matching test payloads, got $matched" }
        $true
    } | Out-Null

    Test-Endpoint -Name "audit: invalid limit" -Method GET -Path "/watchman/audit?limit=99999" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_limit") { return "expected invalid_limit, got $($r.error)" }; $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== Phase 2 -- Constellation + master chart ===" -ForegroundColor Cyan

    Test-Endpoint -Name "constellation/channel: shape" -Method GET -Path "/watchman/constellation/channel" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.tenant_id -ne "bwj") { return "tenant mismatch" }
        if (-not ($r.nodes -is [array])) { return "nodes not array" }
        if (-not ($r.edges -is [array])) { return "edges not array" }
        $channel = @($r.nodes | Where-Object { $_.type -eq "channel" })
        if ($channel.Count -ne 1) { return "expected exactly 1 channel node, got $($channel.Count)" }
        if ($channel[0].id -ne "channel:bwj") { return "channel node id mismatch: $($channel[0].id)" }
        $true
    } | Out-Null

    Test-Endpoint -Name "constellation/video: missing video -> 404" -Method GET -Path "/watchman/constellation/video/__nope__" -ExpectedStatus 404 -Validate {
        param($r); if ($r.error -ne "video_not_found") { return "expected video_not_found, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "chart/master: default days=14, continuous series" -Method GET -Path "/watchman/chart/master" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.tenant_id -ne "bwj") { return "tenant mismatch" }
        if ($r.days -ne 14) { return "days mismatch: $($r.days)" }
        if (-not ($r.series -is [array])) { return "series not array" }
        if ($r.series.Count -ne 14) { return "expected 14 days, got $($r.series.Count)" }
        $first = $r.series[0]
        foreach ($p in "bwj_main","bwj_shorts","tiktok","instagram","facebook","skool") {
            if ($null -eq $first.platforms.$p) { return "missing platform key $p" }
        }
        $true
    } | Out-Null

    Test-Endpoint -Name "chart/master: invalid days" -Method GET -Path "/watchman/chart/master?days=999" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_days") { return "expected invalid_days, got $($r.error)" }; $true
    } | Out-Null

    Write-Host ""
    Write-Host "=== Phase 3 -- sentinel flag endpoints ===" -ForegroundColor Cyan

    Test-Endpoint -Name "flags: list open (empty or array)" -Method GET -Path "/watchman/flags?status=open" -ExpectedStatus 200 -Validate {
        param($r)
        if ($r.status -ne "open") { return "status mismatch" }
        if (-not ($r.flags -is [array])) { return "flags not array" }
        $true
    } | Out-Null

    Test-Endpoint -Name "flags: invalid status" -Method GET -Path "/watchman/flags?status=garbage" -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_status") { return "expected invalid_status, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "flags/resolve: not found" -Method POST -Path "/watchman/flags/__nope__/resolve" `
        -Body @{ resolution = "dismissed" } -ExpectedStatus 404 -Validate {
        param($r); if ($r.error -ne "flag_not_found") { return "expected flag_not_found, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "flags/resolve: invalid resolution" -Method POST -Path "/watchman/flags/__nope__/resolve" `
        -Body @{ resolution = "yolo" } -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "invalid_resolution") { return "expected invalid_resolution, got $($r.error)" }; $true
    } | Out-Null

    Test-Endpoint -Name "flags/resolve: snooze requires snooze_until" -Method POST -Path "/watchman/flags/__nope__/resolve" `
        -Body @{ resolution = "snoozed" } -ExpectedStatus 400 -Validate {
        param($r); if ($r.error -ne "snooze_until_required") { return "expected snooze_until_required, got $($r.error)" }; $true
    } | Out-Null

} catch {
    Write-Host ""
    Write-Host "STOPPED on failure: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Host ""
    Write-Host "================================" -ForegroundColor Cyan
    Write-Host ("Total: {0}  Passed: {1}  Failed: {2}" -f $script:total, $script:passed, $script:failed) -ForegroundColor Cyan
    Write-Host "================================" -ForegroundColor Cyan

    if ($script:createdSnapshotIds.Count -gt 0 -or $script:createdAuditIds.Count -gt 0) {
        Write-Host ""
        Write-Host "Test data written:" -ForegroundColor Yellow
        Write-Host "  daily_snapshots ids: $($script:createdSnapshotIds -join ', ')"
        Write-Host "  watchman_audit_log ids: $($script:createdAuditIds -join ', ')"
        Write-Host ""
        Write-Host "Cleanup SQL (NOT auto-run -- review and execute manually if desired):" -ForegroundColor Yellow
        # daily_snapshots: only the most-recent id will exist (INSERT OR REPLACE deleted earlier rows)
        $snapList = ($script:createdSnapshotIds | ForEach-Object { "'$_'" }) -join ", "
        $auditList = ($script:createdAuditIds | ForEach-Object { "'$_'" }) -join ", "
        Write-Host "  DELETE FROM daily_snapshots WHERE id IN ($snapList);"
        Write-Host "  DELETE FROM watchman_audit_log WHERE id IN ($auditList);"
    }
}
