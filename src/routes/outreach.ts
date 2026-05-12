import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import type { AffiliateBrand, OutreachDraftRow } from "../lib/db";
import { requireAuth } from "../lib/auth";
import {
  loadVoiceReference,
  buildOutreachSystemPrompt,
  buildOutreachUserPrompt,
  findBannedWords,
  stripPlaceholders,
} from "../services/voice";
import { getOutreachSignature } from "../lib/kv";
import { callAnthropic } from "../services/anthropic";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

app.post("/affiliate/outreach/draft", async (c) => {
  let body: { brand_id?: unknown; context_notes?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const brandId = Number(body.brand_id);
  if (!Number.isInteger(brandId) || brandId < 1) {
    return c.json({ error: "brand_id_required" }, 400);
  }
  const contextNotes =
    typeof body.context_notes === "string" ? body.context_notes : null;

  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(brandId)
    .first<AffiliateBrand>();
  if (!brand) return c.json({ error: "brand_not_found" }, 404);

  let voice;
  let signature: string | null;
  try {
    [voice, signature] = await Promise.all([
      loadVoiceReference(c.env),
      getOutreachSignature(c.env),
    ]);
  } catch (e) {
    return c.json(
      {
        error: "voice_reference_unavailable",
        detail: e instanceof Error ? e.message : String(e),
      },
      503,
    );
  }
  if (!signature || !signature.trim()) {
    return c.json(
      {
        error: "outreach_signature_unavailable",
        detail: "outreach_signature not set in KV namespace SECRETS",
      },
      503,
    );
  }

  const systemPrompt = buildOutreachSystemPrompt(voice);
  const userPrompt = buildOutreachUserPrompt({
    name: brand.name,
    category: brand.category,
    fit_reason: brand.fit_reason,
    context_notes: contextNotes,
  });

  let aiResult;
  try {
    aiResult = await callAnthropic(c.env, systemPrompt, userPrompt);
  } catch (e) {
    return c.json(
      {
        error: "anthropic_call_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      502,
    );
  }

  // Parse JSON output. Models sometimes wrap with prose; try direct then extract.
  let parsed: { subject?: unknown; body?: unknown } | null = null;
  let parseError: string | null = null;
  const trimmed = aiResult.text.trim();
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
    } else {
      parseError = "no JSON object in model response";
    }
  }

  if (
    !parsed ||
    typeof parsed.subject !== "string" ||
    typeof parsed.body !== "string"
  ) {
    return c.json(
      {
        error: "model_output_invalid",
        detail: parseError ?? "missing subject or body",
        raw_response: aiResult.text.slice(0, 1000),
        usage: aiResult.usage,
      },
      502,
    );
  }

  const subject = parsed.subject;
  const aiBody = parsed.body;

  // Banned-words check runs on the AI's raw output (pre-strip) so a banned
  // word smuggled inside a placeholder still surfaces a warning.
  const bannedFound = findBannedWords(
    `${subject}\n${aiBody}`,
    voice.rules.banned_words,
  );
  const voiceCalibrationWarning =
    bannedFound.length > 0
      ? `Banned word${bannedFound.length > 1 ? "s" : ""} found in draft: ${bannedFound.join(", ")}. Review carefully.`
      : null;

  const cleanedBody = stripPlaceholders(aiBody);
  const finalBody = `${cleanedBody}\n\n${signature.trim()}`;

  const insert = await c.env.DB.prepare(
    "INSERT INTO outreach_queue (brand_id, draft_subject, draft_body, status) VALUES (?, ?, ?, 'pending')",
  )
    .bind(brandId, subject, finalBody)
    .run();
  const draftId = insert.meta.last_row_id as number;

  return c.json(
    {
      draft_id: draftId,
      brand_id: brandId,
      brand_name: brand.name,
      subject,
      body: finalBody,
      status: "pending",
      voice_calibration_warning: voiceCalibrationWarning,
      usage: aiResult.usage,
      model: aiResult.model,
    },
    201,
  );
});

app.get("/affiliate/outreach/queue", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT q.*, b.name AS brand_name
     FROM outreach_queue q
     JOIN affiliate_brands b ON b.id = q.brand_id
     WHERE q.status = 'pending'
     ORDER BY q.drafted_at DESC, q.id DESC`,
  ).all();
  return c.json({ count: results.length, drafts: results });
});

app.patch("/affiliate/outreach/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  let body: { subject?: unknown; body?: unknown; edits_made?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const setParts: string[] = [];
  const values: unknown[] = [];
  if (typeof body.subject === "string") {
    setParts.push("draft_subject = ?");
    values.push(body.subject);
  }
  if (typeof body.body === "string") {
    setParts.push("draft_body = ?");
    values.push(body.body);
  }
  if (typeof body.edits_made === "string") {
    setParts.push("edits_made = ?");
    values.push(body.edits_made);
  }
  if (setParts.length === 0) {
    return c.json({ error: "no_writable_fields" }, 400);
  }
  setParts.push("status = 'edited'");
  setParts.push("reviewed_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE outreach_queue SET ${setParts.join(", ")} WHERE id = ?`;
  const result = await c.env.DB.prepare(sql).bind(...values).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);

  const updated = await c.env.DB.prepare(
    "SELECT * FROM outreach_queue WHERE id = ?",
  )
    .bind(id)
    .first<OutreachDraftRow>();
  return c.json({ draft: updated });
});

app.post("/affiliate/outreach/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  let body: { note?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // body is optional for reject
  }
  const note = typeof body.note === "string" ? body.note : null;

  const setParts = ["status = 'rejected'", "reviewed_at = datetime('now')"];
  const values: unknown[] = [];
  if (note) {
    setParts.push("notes = ?");
    values.push(note);
  }
  values.push(id);
  const sql = `UPDATE outreach_queue SET ${setParts.join(", ")} WHERE id = ?`;
  const result = await c.env.DB.prepare(sql).bind(...values).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);

  const updated = await c.env.DB.prepare(
    "SELECT * FROM outreach_queue WHERE id = ?",
  )
    .bind(id)
    .first<OutreachDraftRow>();
  return c.json({ draft: updated });
});

export default app;
