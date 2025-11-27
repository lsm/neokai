import { config } from "dotenv";
import { join } from "path";

// Load environment variables from .env file in the current working directory
// This allows each instance (dev, self-hosting, production) to have its own configuration
config({ path: join(process.cwd(), ".env") });

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

export interface ConfigOverrides {
  port?: number;
  host?: string;
  workspace?: string;
  dbPath?: string;
}

export function getConfig(overrides?: ConfigOverrides): Config {
  const nodeEnv = process.env.NODE_ENV || "development";

  // Find project root by going up from daemon package directory
  // __dirname is packages/daemon/src, so we need to go up 3 levels
  const projectRoot = join(__dirname, "..", "..", "..");

  // Default workspace root
  let workspaceRoot: string;
  if (overrides?.workspace) {
    // CLI override takes precedence
    workspaceRoot = overrides.workspace;
  } else if (nodeEnv === "development") {
    // In development: use project_root/tmp/workspace
    workspaceRoot = join(projectRoot, "tmp", "workspace");
  } else {
    // In production: use current working directory
    workspaceRoot = process.cwd();
  }

  return {
    port: overrides?.port ?? parseInt(process.env.PORT || "9283"),
    host: overrides?.host ?? (process.env.HOST || "0.0.0.0"),
    dbPath: overrides?.dbPath ?? (process.env.DB_PATH || "./data/daemon.db"),
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
