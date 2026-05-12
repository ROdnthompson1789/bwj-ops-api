import type { Bindings } from "./types";

export interface SentinelFlagInput {
  tenant_id: string;
  threshold_id: string;
  title: string;
  body: string | null;
  action_due_at?: string | null;
  related_platform?: string | null;
  related_video_id?: string | null;
  related_brand_id?: number | null;
}

export interface SentinelFlagRow {
  id: string;
  tenant_id: string;
  threshold_id: string;
  fired_at: string;
  resolved_at: string | null;
  resolution: string | null;
  title: string;
  body: string | null;
  action_due_at: string | null;
  related_platform: string | null;
  related_video_id: string | null;
  related_brand_id: number | null;
}

export interface UpsertFlagResult {
  flag_id: string;
  action: "inserted" | "updated";
}

/**
 * Idempotent flag upsert. If an unresolved flag with the same
 * (tenant_id, threshold_id) exists, its body/title are refreshed in place.
 * Otherwise a new row is inserted. All writes go through db.batch() so the
 * pre-check and write are part of one D1 transaction (D1 does not support
 * BEGIN/COMMIT in Workers — see CLAUDE_CODE rule "D1 transaction pattern").
 */
export async function upsertSentinelFlag(
  env: Bindings,
  input: SentinelFlagInput,
): Promise<UpsertFlagResult> {
  const existing = await env.DB.prepare(
    `SELECT id FROM sentinel_flags
     WHERE tenant_id = ? AND threshold_id = ? AND resolution IS NULL
     LIMIT 1`,
  )
    .bind(input.tenant_id, input.threshold_id)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sentinel_flags
         SET title = ?, body = ?, action_due_at = ?,
             related_platform = ?, related_video_id = ?, related_brand_id = ?
         WHERE id = ?`,
      ).bind(
        input.title,
        input.body,
        input.action_due_at ?? null,
        input.related_platform ?? null,
        input.related_video_id ?? null,
        input.related_brand_id ?? null,
        existing.id,
      ),
    ]);
    return { flag_id: existing.id, action: "updated" };
  }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sentinel_flags
         (id, tenant_id, threshold_id, title, body, action_due_at,
          related_platform, related_video_id, related_brand_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.tenant_id,
      input.threshold_id,
      input.title,
      input.body,
      input.action_due_at ?? null,
      input.related_platform ?? null,
      input.related_video_id ?? null,
      input.related_brand_id ?? null,
    ),
  ]);
  return { flag_id: id, action: "inserted" };
}
