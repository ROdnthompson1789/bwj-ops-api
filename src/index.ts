import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings } from "./lib/types";
import { verifyToken } from "./lib/auth";
import affiliateRoutes from "./routes/affiliate";
import outreachRoutes from "./routes/outreach";
import alertsRoutes from "./routes/alerts";
import scheduledRoutes from "./routes/scheduled";
import watchmanRoutes from "./routes/watchman";
import { runYouTubePull } from "./lib/cron-youtube";
import { runThresholdEval } from "./scheduled/threshold-eval";
import { runSentinelStallCheck } from "./scheduled/sentinel-stall";
import { runMilestoneCheck } from "./scheduled/milestone";

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (/^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin)) return origin;
      if (/^https:\/\/([a-z0-9-]+\.)+workers\.dev$/i.test(origin)) return origin;
      if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return origin;
      if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return origin;
      return null;
    },
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/health", async (c) => {
  let dbPing: "ok" | "error" = "ok";
  let dbError: string | undefined;
  try {
    const result = await c.env.DB.prepare("SELECT 1 AS ping").first<{
      ping: number;
    }>();
    if (result?.ping !== 1) {
      dbPing = "error";
      dbError = "unexpected ping result";
    }
  } catch (err) {
    dbPing = "error";
    dbError = err instanceof Error ? err.message : String(err);
  }
  return c.json(
    {
      status: dbPing === "ok" ? "ok" : "degraded",
      worker: "bwj-ops-api",
      version: c.env.WORKER_VERSION,
      environment: c.env.ENVIRONMENT,
      database: { ping: dbPing, error: dbError },
      timestamp: new Date().toISOString(),
    },
    dbPing === "ok" ? 200 : 503,
  );
});

app.post("/auth/verify", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ ok: false, error: "missing_bearer_token" }, 401);
  }
  const ok = await verifyToken(c.env, match[1].trim());
  if (!ok) {
    return c.json({ ok: false, error: "invalid_token" }, 401);
  }
  return c.json({ ok: true });
});

app.route("/", affiliateRoutes);
app.route("/", outreachRoutes);
app.route("/", alertsRoutes);
app.route("/", scheduledRoutes);
app.route("/", watchmanRoutes);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("worker_error", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event, env, ctx) {
    switch (event.cron) {
      case "0 11 * * *":
        ctx.waitUntil(
          runYouTubePull(env).catch((err) => {
            console.error("cron_youtube_pull_failed", err);
          }),
        );
        break;
      case "15 11 * * *":
        ctx.waitUntil(
          runThresholdEval(env)
            .then((r) => console.log("cron_threshold_eval_ok", JSON.stringify(r)))
            .catch((err) => console.error("cron_threshold_eval_failed", err)),
        );
        break;
      case "0 * * * *":
        ctx.waitUntil(
          runSentinelStallCheck(env)
            .then((r) => console.log("cron_sentinel_stall_ok", JSON.stringify(r)))
            .catch((err) => console.error("cron_sentinel_stall_failed", err)),
        );
        break;
      case "0 12 * * *":
        ctx.waitUntil(
          runMilestoneCheck(env)
            .then((r) => console.log("cron_milestone_ok", JSON.stringify(r)))
            .catch((err) => console.error("cron_milestone_failed", err)),
        );
        break;
      default:
        console.warn("cron_unknown_schedule", event.cron);
    }
  },
} satisfies ExportedHandler<Bindings>;
