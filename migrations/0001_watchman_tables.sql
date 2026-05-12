-- Watchman Phase 1 Step 1.1 — D1 schema migration
-- Adds six tables to bwj-ops-db per Watchman_Design_Spec_v1.docx Section 11.1.
-- All tables include tenant_id for Syncratic multi-tenant readiness.
--
-- Deviation from spec, with approval (2026-05-11):
--   sentinel_flags.related_brand_id is INTEGER (not TEXT) to match
--   affiliate_brands.id (INTEGER PRIMARY KEY AUTOINCREMENT). Spec doc
--   should be updated to reflect this.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  views INTEGER,
  followers INTEGER,
  new_followers_today INTEGER,
  ctr REAL,
  watch_time_minutes INTEGER,
  reach INTEGER,
  activity_count INTEGER,
  source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_daily_snapshots_tenant_platform_date
  ON daily_snapshots(tenant_id, platform, snapshot_date);

CREATE TABLE IF NOT EXISTS video_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  video_title TEXT,
  snapshot_date TEXT NOT NULL,
  lifetime_views INTEGER,
  ctr REAL,
  avg_view_duration_seconds INTEGER,
  subs_gained INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clip_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  source_video_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  views INTEGER,
  hook_formula TEXT,
  voice_formula TEXT,
  cast_member TEXT,
  content_gap_term TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentinel_flags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  threshold_id TEXT NOT NULL,
  fired_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution TEXT,
  title TEXT NOT NULL,
  body TEXT,
  action_due_at TEXT,
  related_platform TEXT,
  related_video_id TEXT,
  related_brand_id INTEGER REFERENCES affiliate_brands(id)
);

CREATE TABLE IF NOT EXISTS watchman_audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_at TEXT DEFAULT CURRENT_TIMESTAMP,
  user_action TEXT,
  related_flag_id TEXT,
  notes TEXT
);
