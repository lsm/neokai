import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// Load environment variables (without validating against .env.example)
const env = await load({
  export: true,
  examplePath: null, // Don't validate against .env.example
});

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  anthropicApiKey?: string; // Optional now - can use OAuth instead
  claudeCodeOAuthToken?: string; // Long-lived OAuth token from `claude setup-token`
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  maxSessions: number;
  // OAuth settings
  oauthClientId: string;
  oauthAuthUrl: string;
  oauthTokenUrl: string;
  oauthRedirectUri: string;
  oauthScopes: string;
}

export function getConfig(): Config {
  return {
    port: parseInt(env.PORT || Deno.env.get("PORT") || "8283"),
    host: env.HOST || Deno.env.get("HOST") || "0.0.0.0",
    dbPath: env.DB_PATH || Deno.env.get("DB_PATH") || "./data/daemon.db",
    anthropicApiKey: env.ANTHROPIC_API_KEY || Deno.env.get("ANTHROPIC_API_KEY"),
    claudeCodeOAuthToken: env.CLAUDE_CODE_OAUTH_TOKEN || Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN"),
    defaultModel: env.DEFAULT_MODEL || Deno.env.get("DEFAULT_MODEL") ||
      "claude-sonnet-4-5-20241022",
    maxTokens: parseInt(env.MAX_TOKENS || Deno.env.get("MAX_TOKENS") || "8192"),
    temperature: parseFloat(env.TEMPERATURE || Deno.env.get("TEMPERATURE") || "1.0"),
    maxSessions: parseInt(env.MAX_SESSIONS || Deno.env.get("MAX_SESSIONS") || "10"),
    // OAuth configuration (Claude.ai official endpoints)
    oauthClientId: env.OAUTH_CLIENT_ID || Deno.env.get("OAUTH_CLIENT_ID") ||
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    oauthAuthUrl: env.OAUTH_AUTH_URL || Deno.env.get("OAUTH_AUTH_URL") ||
      "https://claude.ai/oauth/authorize",
    oauthTokenUrl: env.OAUTH_TOKEN_URL || Deno.env.get("OAUTH_TOKEN_URL") ||
      "https://console.anthropic.com/v1/oauth/token",
    oauthRedirectUri: env.OAUTH_REDIRECT_URI || Deno.env.get("OAUTH_REDIRECT_URI") ||
      "https://console.anthropic.com/oauth/code/callback",
    oauthScopes: env.OAUTH_SCOPES || Deno.env.get("OAUTH_SCOPES") ||
      "org:create_api_key user:profile user:inference",
  };
}
