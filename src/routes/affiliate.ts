import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import type { AffiliateBrand, StateHistoryRow } from "../lib/db";
import { requireAuth } from "../lib/auth";
import {
  STATES,
  isValidState,
  canTransition,
  type AffiliateState,
} from "../lib/state-machine";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

const BRAND_FIELDS_WRITABLE = [
  "name",
  "category",
  "website",
  "affiliate_program_url",
  "contact_name",
  "contact_email",
  "fit_reason",
  "rejection_reason",
  "commission_rate",
  "min_subs_required",
  "current_link_url",
  "notes",
] as const;

app.get("/affiliate/brands", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands ORDER BY id",
  ).all<AffiliateBrand>();
  return c.json({ brands: results, count: results.length });
});

app.get("/affiliate/brands/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  if (!brand) return c.json({ error: "not_found" }, 404);

  const history = await c.env.DB.prepare(
    "SELECT * FROM affiliate_state_history WHERE brand_id = ? ORDER BY changed_at ASC, id ASC",
  )
    .bind(id)
    .all<StateHistoryRow>();

  return c.json({ brand, state_history: history.results });
});

app.post("/affiliate/brands", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return c.json({ error: "name_required" }, 400);
  }

  let initialState: AffiliateState = "DISCOVERED";
  if (typeof body.state === "string") {
    if (!isValidState(body.state)) {
      return c.json({ error: "invalid_state", allowed: STATES }, 400);
    }
    initialState = body.state;
  }

  const cols: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];
  for (const field of BRAND_FIELDS_WRITABLE) {
    if (field in body) {
      cols.push(field);
      placeholders.push("?");
      values.push(body[field] ?? null);
    }
  }
  cols.push("state", "state_changed_at", "state_changed_by");
  placeholders.push("?", "datetime('now')", "?");
  values.push(initialState, "manual");

  const sql = `INSERT INTO affiliate_brands (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
  const insert = await c.env.DB.prepare(sql).bind(...values).run();
  const newId = insert.meta.last_row_id as number;

  await c.env.DB.prepare(
    "INSERT INTO affiliate_state_history (brand_id, from_state, to_state, changed_by, trigger_reason) VALUES (?, NULL, ?, 'manual', 'Initial creation')",
  )
    .bind(newId, initialState)
    .run();

  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(newId)
    .first<AffiliateBrand>();
  return c.json({ brand }, 201);
});

app.patch("/affiliate/brands/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const setParts: string[] = [];
  const values: unknown[] = [];
  for (const field of BRAND_FIELDS_WRITABLE) {
    if (field in body) {
      setParts.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
  }
  if (setParts.length === 0) {
    return c.json({ error: "no_writable_fields" }, 400);
  }
  setParts.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE affiliate_brands SET ${setParts.join(", ")} WHERE id = ?`;
  const result = await c.env.DB.prepare(sql).bind(...values).run();
  if (result.meta.changes === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  return c.json({ brand });
});

app.post("/affiliate/brands/:id/state", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  let body: {
    to_state?: unknown;
    trigger_reason?: unknown;
    note?: unknown;
    override?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.to_state !== "string" || !isValidState(body.to_state)) {
    return c.json({ error: "invalid_to_state", allowed: STATES }, 400);
  }
  const toState: AffiliateState = body.to_state;
  const triggerReason =
    typeof body.trigger_reason === "string" ? body.trigger_reason : null;
  const note = typeof body.note === "string" ? body.note : null;
  const override = body.override === true;

  if (override && (!note || !note.trim())) {
    return c.json({ error: "note_required_for_override" }, 400);
  }

  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  if (!brand) return c.json({ error: "not_found" }, 404);

  if (!isValidState(brand.state)) {
    return c.json(
      { error: "current_state_invalid", current: brand.state },
      500,
    );
  }
  const fromState: AffiliateState = brand.state;

  if (override && fromState === toState) {
    return c.json(
      { error: "noop_transition", from: fromState, to: toState },
      400,
    );
  }
  if (!override && !canTransition(fromState, toState)) {
    return c.json(
      {
        error: "invalid_transition",
        from: fromState,
        to: toState,
        message: `Transition ${fromState} → ${toState} is not allowed. Set override:true with a note to force.`,
      },
      400,
    );
  }

  const changedBy = override ? "admin_override" : "manual";
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE affiliate_brands
       SET state = ?, state_changed_at = datetime('now'), state_changed_by = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(toState, changedBy, id),
    c.env.DB.prepare(
      `INSERT INTO affiliate_state_history (brand_id, from_state, to_state, changed_by, trigger_reason, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, fromState, toState, changedBy, triggerReason, note),
  ]);

  const updated = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  return c.json({
    brand: updated,
    transition: { from: fromState, to: toState },
    override,
  });
});

app.post("/affiliate/brands/:id/reset-stall-clock", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  let body: { note?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // body is optional
  }
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const brand = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  if (!brand) return c.json({ error: "not_found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE affiliate_brands
       SET state_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `INSERT INTO affiliate_state_history (brand_id, from_state, to_state, changed_by, trigger_reason, note)
       VALUES (?, ?, ?, 'admin_override', 'stall_clock_reset', ?)`,
    ).bind(id, brand.state, brand.state, note),
  ]);

  const updated = await c.env.DB.prepare(
    "SELECT * FROM affiliate_brands WHERE id = ?",
  )
    .bind(id)
    .first<AffiliateBrand>();
  return c.json({ brand: updated, action: "stall_clock_reset" });
});

app.get("/affiliate/state-changes", async (c) => {
  const days = Number(c.req.query("days") ?? 7);
  if (!Number.isFinite(days) || days < 0 || days > 365) {
    return c.json({ error: "invalid_days_param", allowed: "0..365" }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT h.id, h.brand_id, b.name AS brand_name, h.from_state, h.to_state,
            h.changed_at, h.changed_by, h.trigger_reason, h.note
     FROM affiliate_state_history h
     JOIN affiliate_brands b ON b.id = h.brand_id
     WHERE julianday('now') - julianday(h.changed_at) <= ?
     ORDER BY h.changed_at DESC, h.id DESC`,
  )
    .bind(days)
    .all();
  return c.json({ days, count: results.length, state_changes: results });
});

export default app;
