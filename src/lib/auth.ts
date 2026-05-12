import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./types";

export const verifyToken = async (env: Bindings, token: string): Promise<boolean> => {
  const expected = await env.SECRETS.get("api_access_token");
  if (!expected || !token) return false;
  if (expected.length !== token.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
};

export const requireAuth: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  const ok = await verifyToken(c.env, match[1].trim());
  if (!ok) {
    return c.json({ error: "invalid_token" }, 401);
  }
  await next();
};
