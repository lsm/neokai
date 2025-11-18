import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// Load environment variables
const env = await load({ export: true });

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  anthropicApiKey: string;
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  maxSessions: number;
}

export function getConfig(): Config {
  return {
    port: parseInt(env.PORT || Deno.env.get("PORT") || "8283"),
    host: env.HOST || Deno.env.get("HOST") || "0.0.0.0",
    dbPath: env.DB_PATH || Deno.env.get("DB_PATH") || "./data/daemon.db",
    anthropicApiKey: env.ANTHROPIC_API_KEY || Deno.env.get("ANTHROPIC_API_KEY") || "",
    defaultModel: env.DEFAULT_MODEL || Deno.env.get("DEFAULT_MODEL") ||
      "claude-sonnet-4-5-20241022",
    maxTokens: parseInt(env.MAX_TOKENS || Deno.env.get("MAX_TOKENS") || "8192"),
    temperature: parseFloat(env.TEMPERATURE || Deno.env.get("TEMPERATURE") || "1.0"),
    maxSessions: parseInt(env.MAX_SESSIONS || Deno.env.get("MAX_SESSIONS") || "10"),
  };
}
