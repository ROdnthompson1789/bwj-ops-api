import type { Bindings } from "./types";
import { callAnthropic } from "../services/anthropic";

export interface ThresholdSpec {
  id: string;
  type?: "static" | "dynamic";
  title: string;
  body_template?: string | null;
  prompt?: string | null;
  context?: Record<string, unknown>;
}

const replaceVars = (
  template: string,
  vars: Record<string, unknown>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });

/**
 * Produce the body text for a fired flag. Static templates substitute
 * {{vars}} from `context`. Dynamic templates call the Anthropic API with
 * the voice_reference KV value as the system prompt so the draft lands
 * in BWJ voice.
 */
export async function buildFlagBody(
  env: Bindings,
  threshold: ThresholdSpec,
  context: Record<string, unknown> = {},
): Promise<string> {
  const merged = { ...(threshold.context ?? {}), ...context };

  if (threshold.type !== "dynamic") {
    if (!threshold.body_template) return threshold.title;
    return replaceVars(threshold.body_template, merged);
  }

  const prompt = threshold.prompt
    ? replaceVars(threshold.prompt, merged)
    : `Threshold "${threshold.title}" fired. Context: ${JSON.stringify(merged)}.`;

  const voiceReference =
    (await env.SECRETS.get("voice_reference")) ??
    "You are drafting a short operational note for BWJ (Blackwater Outdoor Journeys). Keep it short, plainspoken, no marketing fluff.";

  const { text } = await callAnthropic(env, voiceReference, prompt, {
    maxTokens: 1024,
  });
  return text.trim();
}
