import type { Bindings } from "../lib/types";
import { upsertSentinelFlag } from "../lib/sentinel-flags";

// Strategic Coach review dates per packet Lane 3 Step 3.4. Hard-coded
// per packet — tenant config can override this in v2.
const COACH_REVIEW_MONTH_DAYS: Array<[number, number]> = [
  [8, 1],   // Aug 1
  [11, 1],  // Nov 1
  [2, 1],   // Feb 1
  [5, 1],   // May 1
];

// Last day of each calendar quarter (UTC).
const QUARTER_CLOSE_MONTH_DAYS: Array<[number, number]> = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

const ISO = (d: Date) => d.toISOString().slice(0, 10);

function diffDaysUtc(from: Date, to: Date): number {
  const ms = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) -
             Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round(ms / 86_400_000);
}

function nextOccurrence(today: Date, month: number, day: number): Date {
  const year = today.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (diffDaysUtc(today, candidate) < 0) {
    return new Date(Date.UTC(year + 1, month - 1, day));
  }
  return candidate;
}

export interface MilestoneResult {
  tenant_id: string;
  checked_at: string;
  coach_fired: number;
  quarter_fired: number;
  inserted: number;
  updated: number;
}

export async function runMilestoneCheck(env: Bindings, now: Date = new Date()): Promise<MilestoneResult> {
  const tenantId = env.TENANT_ID;
  const summary: MilestoneResult = {
    tenant_id: tenantId,
    checked_at: now.toISOString(),
    coach_fired: 0,
    quarter_fired: 0,
    inserted: 0,
    updated: 0,
  };

  for (const [month, day] of COACH_REVIEW_MONTH_DAYS) {
    const reviewDate = nextOccurrence(now, month, day);
    const daysUntil = diffDaysUtc(now, reviewDate);
    if (daysUntil < 0 || daysUntil > 7) continue;
    summary.coach_fired++;
    const result = await upsertSentinelFlag(env, {
      tenant_id: tenantId,
      threshold_id: `coach_review:${ISO(reviewDate)}`,
      title: `Strategic Coach review on ${ISO(reviewDate)}`,
      body: `Strategic Coach review is in ${daysUntil} day(s) (${ISO(reviewDate)}). Prep notes, pull KPIs.`,
      action_due_at: reviewDate.toISOString(),
    });
    if (result.action === "inserted") summary.inserted++;
    else summary.updated++;
  }

  for (const [month, day] of QUARTER_CLOSE_MONTH_DAYS) {
    const close = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
    if (diffDaysUtc(now, close) !== 0) continue;
    summary.quarter_fired++;
    const result = await upsertSentinelFlag(env, {
      tenant_id: tenantId,
      threshold_id: `quarter_close:${ISO(close)}`,
      title: `Quarter close: ${ISO(close)}`,
      body: `Quarter ends today (${ISO(close)}). Close books, log review, file outcomes.`,
      action_due_at: close.toISOString(),
    });
    if (result.action === "inserted") summary.inserted++;
    else summary.updated++;
  }

  return summary;
}
