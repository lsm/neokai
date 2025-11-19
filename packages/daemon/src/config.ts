import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file in the daemon package directory
// This ensures the .env file is loaded regardless of the current working directory
config({ path: join(__dirname, "..", ".env") });

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
  nodeEnv: string;
  workspaceRoot: string;
}

export function getConfig(): Config {
  const nodeEnv = process.env.NODE_ENV || "development";

  // Find project root by going up from daemon package directory
  // __dirname is packages/daemon/src, so we need to go up 3 levels
  const projectRoot = join(__dirname, "..", "..", "..");

  // In development: use project_root/tmp/workspace
  // In production: use current working directory
  const workspaceRoot = nodeEnv === "development"
    ? join(projectRoot, "tmp", "workspace")
    : process.cwd();

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
    nodeEnv,
    workspaceRoot,
  };
}
