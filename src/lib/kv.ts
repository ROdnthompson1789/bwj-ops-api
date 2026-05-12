import type { Bindings } from "./types";

export const getApiAccessToken = (env: Bindings) =>
  env.SECRETS.get("api_access_token");

export const getAnthropicApiKey = (env: Bindings) =>
  env.SECRETS.get("anthropic_api_key");

export const getYouTubeApiKey = (env: Bindings) =>
  env.SECRETS.get("youtube_api_key");

export const getVoiceReference = (env: Bindings) =>
  env.SECRETS.get("voice_reference");

export const getOutreachSignature = (env: Bindings) =>
  env.SECRETS.get("outreach_signature");
