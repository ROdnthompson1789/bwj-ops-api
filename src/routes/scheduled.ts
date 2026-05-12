import { Hono } from "hono";
import type { Bindings } from "../lib/types";
import { requireAuth } from "../lib/auth";
import { runStallCheck } from "../scheduled/stall-check";
import { runYouTubePull } from "../lib/cron-youtube";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requireAuth);

app.post("/scheduled/stall-check/run", async (c) => {
  const result = await runStallCheck(c.env);
  return c.json(result);
});

app.post("/scheduled/youtube-pull/run", async (c) => {
  const result = await runYouTubePull(c.env);
  return c.json(result);
});

export default app;
