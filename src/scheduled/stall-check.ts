import type { Bindings } from "../lib/types";
import {
  STALL_RULES,
  isValidState,
  type AffiliateState,
} from "../lib/state-machine";

export interface StallAlert {
  brand_id: number;
  brand_name: string;
  state: string;
  days_in_state: number;
  alert_id: number;
  title: string;
}

export interface StallCheckResult {
  checked: number;
  fired: number;
  skipped_duplicates: number;
  alerts: StallAlert[];
}

interface CandidateRow {
  id: number;
  name: string;
  state: string;
  state_changed_at: string;
  days_in_state: number;
}

export async function runStallCheck(env: Bindings): Promise<StallCheckResult> {
  const candidates = await env.DB.prepare(
    `SELECT id, name, state, state_changed_at,
            CAST(julianday('now') - julianday(state_changed_at) AS INTEGER) AS days_in_state
     FROM affiliate_brands
     WHERE state NOT IN ('CLOSED','CONSIDERED-REJECTED')`,
  ).all<CandidateRow>();

  const result: StallCheckResult = {
    checked: candidates.results.length,
    fired: 0,
    skipped_duplicates: 0,
    alerts: [],
  };

  for (const brand of candidates.results) {
    if (!isValidState(brand.state)) continue;
    const rule = STALL_RULES[brand.state as AffiliateState];
    if (!rule) continue;
    if (brand.days_in_state < rule.days) continue;

    const existing = await env.DB.prepare(
      "SELECT id FROM alerts WHERE source='stall_check' AND related_brand_id=? AND status='open' LIMIT 1",
    )
      .bind(brand.id)
      .first<{ id: number }>();

    if (existing) {
      result.skipped_duplicates++;
      continue;
    }

    const insert = await env.DB.prepare(
      `INSERT INTO alerts (source, severity, title, body, related_brand_id, decision_required, status)
       VALUES ('stall_check', 'warning', ?, ?, ?, 1, 'open')`,
    )
      .bind(
        `${rule.title}: ${brand.name}`,
        `${rule.body} (Brand has been in ${brand.state} for ${brand.days_in_state} days.)`,
        brand.id,
      )
      .run();

    result.fired++;
    result.alerts.push({
      brand_id: brand.id,
      brand_name: brand.name,
      state: brand.state,
      days_in_state: brand.days_in_state,
      alert_id: insert.meta.last_row_id as number,
      title: rule.title,
    });
  }

  return result;
}
