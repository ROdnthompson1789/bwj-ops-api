import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import type { AlertRow } from "../lib/db";
import { requireAuth } from "../lib/auth";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

app.patch("/alerts/:id/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "invalid_id" }, 400);
  }
  const result = await c.env.DB.prepare(
    "UPDATE alerts SET status = 'dismissed', acted_at = datetime('now') WHERE id = ? AND status = 'open'",
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    const existing = await c.env.DB.prepare(
      "SELECT id, status FROM alerts WHERE id = ?",
    )
      .bind(id)
      .first<{ id: number; status: string }>();
    if (!existing) return c.json({ error: "not_found" }, 404);
    return c.json(
      { error: "alert_not_open", current_status: existing.status },
      409,
    );
  }

  const alert = await c.env.DB.prepare("SELECT * FROM alerts WHERE id = ?")
    .bind(id)
    .first<AlertRow>();
  return c.json({ alert });
});

export default app;
