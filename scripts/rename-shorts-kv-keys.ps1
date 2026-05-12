# Migrate Shorts OAuth KV keys from suffix-style to prefix-style.
#
# Original key shape (from earlier oauth-bootstrap-shorts.js):
#   youtube_oauth_client_id_shorts
#   youtube_oauth_client_secret_shorts
#   youtube_oauth_refresh_token_shorts
# Target key shape (matches data-driven credentials_key="youtube_oauth_shorts"):
#   youtube_oauth_shorts_client_id
#   youtube_oauth_shorts_client_secret
#   youtube_oauth_shorts_refresh_token
#
# This script is idempotent:
#   - If NEW exists and OLD missing: prints "already migrated", exits 0.
#   - If NEW missing and OLD exists: copies OLD -> NEW, verifies, deletes OLD.
#   - If both exist with matching values: deletes OLD.
#   - If both exist with mismatched values: FAILS loudly, takes no action.
#   - If neither exists: FAILS (nothing to migrate, nothing in target state).
#
# Safe to run any number of times.

$ErrorActionPreference = "Stop"
$NS = "bc0bebb969fa47cfaeeeda85a8c0997d"

$pairs = @(
  @{ Old = "youtube_oauth_client_id_shorts";     New = "youtube_oauth_shorts_client_id" },
  @{ Old = "youtube_oauth_client_secret_shorts"; New = "youtube_oauth_shorts_client_secret" },
  @{ Old = "youtube_oauth_refresh_token_shorts"; New = "youtube_oauth_shorts_refresh_token" }
)

function Get-KvValue {
  param([string] $Key)
  $out = wrangler kv key get --namespace-id=$NS $Key --remote 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $out -match "key not found|Key not found") {
    return $null
  }
  return $out.Trim()
}

function Redact {
  param([string] $Value)
  if (-not $Value) { return "<empty>" }
  return "$($Value.Substring(0, [Math]::Min(8, $Value.Length)))...($($Value.Length) chars)"
}

Write-Host "Shorts KV key migration (suffix -> prefix)" -ForegroundColor Cyan
Write-Host "Namespace: $NS"
Write-Host ""

$summary = @()

foreach ($pair in $pairs) {
  $oldKey = $pair.Old
  $newKey = $pair.New
  Write-Host "--- $oldKey -> $newKey ---" -ForegroundColor Cyan

  $oldVal = Get-KvValue -Key $oldKey
  $newVal = Get-KvValue -Key $newKey

  if (-not $oldVal -and -not $newVal) {
    Write-Host "  FAIL: neither key exists. Nothing to migrate." -ForegroundColor Red
    throw "missing_both_keys: $oldKey"
  }

  if (-not $oldVal -and $newVal) {
    Write-Host "  SKIP: already migrated. NEW = $(Redact $newVal)" -ForegroundColor Green
    $summary += [pscustomobject]@{ Key = $newKey; Action = "already_migrated"; Redacted = (Redact $newVal) }
    continue
  }

  if ($oldVal -and $newVal -and $oldVal -ne $newVal) {
    Write-Host "  FAIL: both keys exist with different values. Refusing to clobber." -ForegroundColor Red
    Write-Host "    OLD = $(Redact $oldVal)"
    Write-Host "    NEW = $(Redact $newVal)"
    throw "value_mismatch: $oldKey vs $newKey"
  }

  if ($oldVal -and $newVal -and $oldVal -eq $newVal) {
    Write-Host "  CLEANUP: both keys exist with matching values. Deleting OLD only." -ForegroundColor Yellow
    wrangler kv key delete --namespace-id=$NS --remote $oldKey | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "delete_failed: $oldKey" }
    $summary += [pscustomobject]@{ Key = $newKey; Action = "old_deleted"; Redacted = (Redact $newVal) }
    continue
  }

  # OLD exists, NEW does not -- do the actual migration.
  if ($oldVal.Length -lt 8) {
    Write-Host "  FAIL: OLD value suspiciously short ($($oldVal.Length) chars). Refusing." -ForegroundColor Red
    throw "value_too_short: $oldKey"
  }

  Write-Host "  COPY: OLD ($(Redact $oldVal)) -> NEW"
  wrangler kv key put --namespace-id=$NS --remote $newKey $oldVal | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "put_failed: $newKey" }

  $writtenBack = Get-KvValue -Key $newKey
  if ($writtenBack -ne $oldVal) {
    Write-Host "  FAIL: NEW read-back doesn't match OLD. Aborting before delete." -ForegroundColor Red
    throw "verify_failed: $newKey"
  }
  Write-Host "  VERIFY: NEW read-back matches OLD"

  wrangler kv key delete --namespace-id=$NS --remote $oldKey | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "delete_failed: $oldKey" }
  Write-Host "  DELETE: OLD removed" -ForegroundColor Green
  $summary += [pscustomobject]@{ Key = $newKey; Action = "migrated"; Redacted = (Redact $oldVal) }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$summary | Format-Table -AutoSize
