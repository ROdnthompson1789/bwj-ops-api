import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import { requireAuth } from "../lib/auth";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

const VALID_DATA_KEYS = new Set(["fieldlog", "shotplan", "tripdata", "checklist"]);

// GET /dashboard/config
app.get("/config", async (c) => {
  const [season, vara, varb, ceiling, updated, driveurl, apiKeyExists] =
    await Promise.all([
      c.env.SECRETS.get("dashboard_traj_season"),
      c.env.SECRETS.get("dashboard_traj_vara"),
      c.env.SECRETS.get("dashboard_traj_varb"),
      c.env.SECRETS.get("dashboard_traj_ceiling"),
      c.env.SECRETS.get("dashboard_traj_updated"),
      c.env.SECRETS.get("dashboard_driveurl"),
      c.env.SECRETS.get("anthropic_api_key"),
    ]);

  return c.json({
    traj_season: season,
    traj_vara: vara,
    traj_varb: varb,
    traj_ceiling: ceiling,
    traj_updated: updated,
    driveurl: driveurl,
    apikey_configured: Boolean(apiKeyExists),
  });
});

// POST /dashboard/config
app.post("/config", async (c) => {
  let body: Record<string, string>;
  try {
    body = await c.req.json<Record<string, string>>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const writes: Promise<void>[] = [];

  const fieldMap: Record<string, string> = {
    traj_season: "dashboard_traj_season",
    traj_vara: "dashboard_traj_vara",
    traj_varb: "dashboard_traj_varb",
    traj_ceiling: "dashboard_traj_ceiling",
    traj_updated: "dashboard_traj_updated",
    driveurl: "dashboard_driveurl",
  };

  for (const [bodyKey, kvKey] of Object.entries(fieldMap)) {
    if (body[bodyKey] !== undefined && body[bodyKey] !== "") {
      writes.push(c.env.SECRETS.put(kvKey, body[bodyKey]));
    }
  }

  if (body.apikey && body.apikey !== "") {
    writes.push(c.env.SECRETS.put("anthropic_api_key", body.apikey));
  }

  await Promise.all(writes);
  return c.json({ saved: true });
});

// GET /dashboard/data
app.get("/data", async (c) => {
  const tenantId = c.env.TENANT_ID;
  const result = await c.env.DB.prepare(
    "SELECT key, value FROM production_dashboard WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .all<{ key: string; value: string }>();

  const out: Record<string, string | null> = {
    fieldlog: null,
    shotplan: null,
    tripdata: null,
    checklist: null,
  };
  for (const row of result.results) {
    if (row.key in out) out[row.key] = row.value;
  }
  return c.json(out);
});

// POST /dashboard/data
app.post("/data", async (c) => {
  let body: { key: string; value: string };
  try {
    body = await c.req.json<{ key: string; value: string }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!VALID_DATA_KEYS.has(body.key)) {
    return c.json({ error: "invalid_key", valid: [...VALID_DATA_KEYS] }, 400);
  }
  if (typeof body.value !== "string") {
    return c.json({ error: "value_must_be_string" }, 400);
  }

  const tenantId = c.env.TENANT_ID;
  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO production_dashboard (id, tenant_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).bind(id, tenantId, body.key, body.value),
    c.env.DB.prepare(
      `INSERT INTO watchman_audit_log (id, tenant_id, event_type, user_action)
       VALUES (?, ?, 'dashboard_data_save', ?)`,
    ).bind(crypto.randomUUID(), tenantId, JSON.stringify({ key: body.key })),
  ]);

  return c.json({ saved: true });
});

// POST /dashboard/claude — server-side proxy for Anthropic API
app.post("/claude", async (c) => {
  let body: { prompt: string; system?: string; max_tokens?: number };
  try {
    body = await c.req.json<{ prompt: string; system?: string; max_tokens?: number }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!body.prompt) {
    return c.json({ error: "prompt_required" }, 400);
  }

  const apiKey = await c.env.SECRETS.get("anthropic_api_key");
  if (!apiKey) {
    return c.json({ error: "anthropic_api_key_not_configured" }, 503);
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: body.prompt },
  ];

  const requestBody: Record<string, unknown> = {
    model: "claude-sonnet-4-6",
    max_tokens: body.max_tokens ?? 2000,
    messages,
  };
  if (body.system) requestBody.system = body.system;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    return c.json(
      { error: "anthropic_error", status: res.status, detail: errText.slice(0, 500) },
      502,
    );
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text =
    json.content?.find((b) => b.type === "text")?.text ?? "";

  return c.text(text);
});

export { app as dashboardRoutes };
