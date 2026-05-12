import type { Context } from "hono";
import type { Bindings } from "./types";

export const PLATFORM_IDS = [
  "bwj_main",
  "bwj_shorts",
  "tiktok",
  "instagram",
  "facebook",
  "skool",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const isPlatformId = (v: unknown): v is PlatformId =>
  typeof v === "string" && (PLATFORM_IDS as readonly string[]).includes(v);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TenantPlatform {
  id: PlatformId;
  label: string;
  color_start: string;
  color_end: string;
  primary_kpi: string;
  secondary_kpi: string;
  source: "youtube_api" | "manual";
  channel_id?: string;
  handle?: string;
  credentials_key?: string;
}

export interface TenantBrand {
  accent_color: string;
  logo_url: string | null;
  dashboard_name: string;
}

export interface TenantConfig {
  name: string;
  short_name: string;
  brand: TenantBrand;
  platforms: TenantPlatform[];
  cast: string[];
  hook_formulas: string[];
  thresholds: unknown[];
}

export interface DailySnapshotRow {
  id: string;
  tenant_id: string;
  platform: string;
  snapshot_date: string;
  views: number | null;
  followers: number | null;
  new_followers_today: number | null;
  ctr: number | null;
  watch_time_minutes: number | null;
  reach: number | null;
  activity_count: number | null;
  source: string | null;
  created_at: string;
}

export interface WatchmanAuditRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_at: string;
  user_action: string | null;
  related_flag_id: string | null;
  notes: string | null;
}

export interface RollupRow {
  platform: string;
  views_7d: number;
  views_28d: number;
  new_followers_7d: number;
  new_followers_28d: number;
}

export interface LatestFollowersRow {
  platform: string;
  followers: number;
}

export const resolveTenantId = (c: Context<{ Bindings: Bindings }>): string =>
  c.env.TENANT_ID;
