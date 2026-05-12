import type { Bindings } from "../lib/types";
import { upsertSentinelFlag } from "../lib/sentinel-flags";

interface StallCandidate {
  id: number;
  name: string;
  state: string;
  days_in_state: number;
}

const STALL_DAYS = 7;
const WATCHED_STATES = ["DISCOVERED", "CONTACTED", "OUTREACH-SENT"] as const;

export interface SentinelStallResult {
  tenant_id: string;
  candidates_checked: number;
  fired: number;
  inserted: number;
  updated: number;
  errors: Array<{ brand_id: number; error: string }>;
}

/**
 * Hourly cron: scan affiliate_brands for rows in DISCOVERED/CONTACTED
 * (treating OUTREACH-SENT as a near-equivalent stall state) whose
 * last_state_change is more than 7 days ago, and write/refresh a
 * sentinel_flags row per brand. Idempotent on (tenant_id, threshold_id).
 *
 * NB: this complements the older alerts-table stall checker in
 * src/scheduled/stall-check.ts; that one fires into `alerts`, this one
 * fires into the Phase 3 `sentinel_flags` table the Watchman dashboard
 * reads from.
 */
export async function runSentinelStallCheck(env: Bindings): Promise<SentinelStallResult> {
  const tenantId = env.TENANT_ID;
  const summary: SentinelStallResult = {
    tenant_id: tenantId,
    candidates_checked: 0,
    fired: 0,
    inserted: 0,
    updated: 0,
    errors: [],
  };

  const placeholders = WATCHED_STATES.map(() => "?").join(", ");
  const candidates = await env.DB.prepare(
    `SELECT id, name, state,
            CAST(julianday('now') - julianday(state_changed_at) AS INTEGER) AS days_in_state
     FROM affiliate_brands
     WHERE state IN (${placeholders})`,
  )
    .bind(...WATCHED_STATES)
    .all<StallCandidate>();

  summary.candidates_checked = candidates.results.length;

  for (const brand of candidates.results) {
    if (brand.days_in_state < STALL_DAYS) continue;
    try {
      summary.fired++;
      const result = await upsertSentinelFlag(env, {
        tenant_id: tenantId,
        threshold_id: `affiliate_stall:${brand.id}`,
        title: `Affiliate brand stalled in ${brand.state}: ${brand.name}`,
        body: `${brand.name} has sat in ${brand.state} for ${brand.days_in_state} days. Decide: move forward, reject, or note why we're holding.`,
        related_brand_id: brand.id,
      });
      if (result.action === "inserted") summary.inserted++;
      else summary.updated++;
    } catch (err) {
      summary.errors.push({
        brand_id: brand.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
