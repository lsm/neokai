import { config } from "dotenv";

// Load environment variables from .env file
config();

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
    port: parseInt(process.env.PORT || "8283"),
    host: process.env.HOST || "0.0.0.0",
    dbPath: process.env.DB_PATH || "./data/daemon.db",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    defaultModel: process.env.DEFAULT_MODEL || "claude-sonnet-4-5-20241022",
    maxTokens: parseInt(process.env.MAX_TOKENS || "8192"),
    temperature: parseFloat(process.env.TEMPERATURE || "1.0"),
    maxSessions: parseInt(process.env.MAX_SESSIONS || "10"),
    // OAuth configuration (Claude.ai official endpoints)
    oauthClientId: process.env.OAUTH_CLIENT_ID ||
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    oauthAuthUrl: process.env.OAUTH_AUTH_URL ||
      "https://claude.ai/oauth/authorize",
    oauthTokenUrl: process.env.OAUTH_TOKEN_URL ||
      "https://console.anthropic.com/v1/oauth/token",
    oauthRedirectUri: process.env.OAUTH_REDIRECT_URI ||
      "https://console.anthropic.com/oauth/code/callback",
    oauthScopes: process.env.OAUTH_SCOPES ||
      "org:create_api_key user:profile user:inference",
  };
}
