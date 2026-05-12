import type { Bindings } from "../lib/types";
import { upsertSentinelFlag } from "../lib/sentinel-flags";
import { buildFlagBody, type ThresholdSpec } from "../lib/decision-template";

interface DailyKpiCheck {
  kpi: "views" | "followers" | "new_followers_today" | "ctr" | "watch_time_minutes" | "reach" | "activity_count";
  comparator: "lt" | "lte" | "gt" | "gte";
  value: number;
  window_days: number;
  agg: "sum" | "avg" | "max" | "min";
  platform?: string;
}

interface ThresholdConfig extends ThresholdSpec {
  enabled?: boolean;
  check: { kind: "daily_kpi"; spec: DailyKpiCheck } | { kind: "always" };
}

interface TenantThresholdsRow {
  id: string;
  config_json: string;
}

interface AggregateRow {
  result: number | null;
}

const AGG_SQL: Record<DailyKpiCheck["agg"], string> = {
  sum: "SUM",
  avg: "AVG",
  max: "MAX",
  min: "MIN",
};

async function evaluateDailyKpi(
  env: Bindings,
  tenantId: string,
  spec: DailyKpiCheck,
): Promise<number | null> {
  const agg = AGG_SQL[spec.agg] ?? "SUM";
  const where = ["tenant_id = ?", "snapshot_date >= date('now', ?)"];
  const binds: unknown[] = [tenantId, `-${Math.max(spec.window_days - 1, 0)} days`];
  if (spec.platform) {
    where.push("platform = ?");
    binds.push(spec.platform);
  }
  const sql = `SELECT ${agg}(${spec.kpi}) AS result FROM daily_snapshots WHERE ${where.join(" AND ")}`;
  const row = await env.DB.prepare(sql).bind(...binds).first<AggregateRow>();
  return row?.result ?? null;
}

function compare(actual: number, comparator: DailyKpiCheck["comparator"], target: number): boolean {
  switch (comparator) {
    case "lt": return actual < target;
    case "lte": return actual <= target;
    case "gt": return actual > target;
    case "gte": return actual >= target;
  }
}

export interface ThresholdEvalResult {
  tenant_id: string;
  evaluated: number;
  fired: number;
  inserted: number;
  updated: number;
  errors: Array<{ threshold_id: string; error: string }>;
}

export async function runThresholdEval(env: Bindings): Promise<ThresholdEvalResult[]> {
  const tenants = await env.DB.prepare(
    "SELECT id, config_json FROM tenants",
  ).all<TenantThresholdsRow>();

  const summaries: ThresholdEvalResult[] = [];

  for (const tenant of tenants.results) {
    const summary: ThresholdEvalResult = {
      tenant_id: tenant.id,
      evaluated: 0,
      fired: 0,
      inserted: 0,
      updated: 0,
      errors: [],
    };

    let thresholds: ThresholdConfig[] = [];
    try {
      const cfg = JSON.parse(tenant.config_json ?? "{}") as { thresholds?: ThresholdConfig[] };
      thresholds = Array.isArray(cfg.thresholds) ? cfg.thresholds : [];
    } catch {
      summary.errors.push({ threshold_id: "<config_json>", error: "invalid_json" });
      summaries.push(summary);
      continue;
    }

    for (const t of thresholds) {
      if (t.enabled === false) continue;
      summary.evaluated++;
      try {
        let trigger = false;
        const ctx: Record<string, unknown> = {};
        if (t.check.kind === "always") {
          trigger = true;
        } else {
          const actual = await evaluateDailyKpi(env, tenant.id, t.check.spec);
          if (actual !== null) {
            trigger = compare(actual, t.check.spec.comparator, t.check.spec.value);
            ctx.actual = actual;
            ctx.target = t.check.spec.value;
            ctx.kpi = t.check.spec.kpi;
            ctx.window_days = t.check.spec.window_days;
            ctx.platform = t.check.spec.platform ?? null;
          }
        }
        if (!trigger) continue;
        summary.fired++;
        const body = await buildFlagBody(env, t, ctx);
        const platform = t.check.kind === "daily_kpi" ? t.check.spec.platform ?? null : null;
        const result = await upsertSentinelFlag(env, {
          tenant_id: tenant.id,
          threshold_id: t.id,
          title: t.title,
          body,
          related_platform: platform,
        });
        if (result.action === "inserted") summary.inserted++;
        else summary.updated++;
      } catch (err) {
        summary.errors.push({
          threshold_id: t.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    summaries.push(summary);
  }

  return summaries;
}
