import type { Bindings } from "../lib/types";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicTextBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicCallResult {
  text: string;
  usage: AnthropicResponse["usage"];
  model: string;
}

export interface AnthropicCallOptions {
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function callAnthropic(
  env: Bindings,
  systemPrompt: string,
  userPrompt: string,
  opts: AnthropicCallOptions = {},
): Promise<AnthropicCallResult> {
  const apiKey = await env.SECRETS.get("anthropic_api_key");
  if (!apiKey) {
    throw new Error("anthropic_api_key not set in KV namespace SECRETS");
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 2048;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // System prompt cached ephemerally (5-min TTL). Voice reference content
      // is large and stable across drafts, so caching trims input cost ~90%
      // on hits within the same drafting session.
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const json = (await res.json()) as AnthropicResponse;
  const textBlock = json.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("No text block in Anthropic response");
  }
  return { text: textBlock.text, usage: json.usage, model: json.model };
}
