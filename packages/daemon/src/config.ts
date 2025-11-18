import { config } from "dotenv";

// Load environment variables from .env file
config();

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  anthropicApiKey?: string; // Optional - can use CLAUDE_CODE_OAUTH_TOKEN instead
  claudeCodeOAuthToken?: string; // Long-lived OAuth token
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  maxSessions: number;
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
  };
}
