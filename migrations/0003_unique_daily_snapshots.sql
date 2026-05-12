-- Watchman Phase 1 Step 1.3 follow-up — UNIQUE constraint on daily_snapshots.
-- Prevents duplicate rows when Rodney re-syncs the same (platform, date).
-- Paired with INSERT OR REPLACE in POST /watchman/sync/manual: re-syncing
-- overwrites the daily_snapshots row in place, while watchman_audit_log
-- keeps one entry per submission for full traceability.

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_snapshots_unique_per_day
  ON daily_snapshots(tenant_id, platform, snapshot_date);
