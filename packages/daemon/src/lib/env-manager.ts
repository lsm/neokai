import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * EnvManager - Manages .env file for credential storage
 *
 * This ensures credentials are NEVER stored in the database,
 * only in the .env file and environment variables.
 */
export class EnvManager {
  private envPath: string;

  constructor(envPath?: string) {
    // Default to .env in the daemon directory
    this.envPath = envPath || join(process.cwd(), ".env");
  }

  /**
   * Read current .env file contents
   */
  private readEnvFile(): Map<string, string> {
    const envMap = new Map<string, string>();

    if (!existsSync(this.envPath)) {
      return envMap;
    }

    const content = readFileSync(this.envPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse KEY=VALUE
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        envMap.set(key, value);
      }
    }

    return envMap;
  }

  /**
   * Write environment variables to .env file
   */
  private writeEnvFile(envMap: Map<string, string>): void {
    const lines: string[] = [];

    // Group by sections for readability
    const serverKeys = ["PORT", "HOST"];
    const dbKeys = ["DB_PATH"];
    const authKeys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    const modelKeys = ["DEFAULT_MODEL", "MAX_TOKENS", "TEMPERATURE", "MAX_SESSIONS"];

    // Server config
    for (const key of serverKeys) {
      if (envMap.has(key)) {
        lines.push(`${key}=${envMap.get(key)}`);
      }
    }

    // Database config
    for (const key of dbKeys) {
      if (envMap.has(key)) {
        lines.push(`${key}=${envMap.get(key)}`);
      }
    }

    // Auth config (with commented placeholders)
    lines.push("");
    lines.push("# Authentication - Set one of these:");
    for (const key of authKeys) {
      if (envMap.has(key)) {
        const value = envMap.get(key);
        // Don't comment out if value is set
        if (value && value !== "") {
          lines.push(`${key}=${value}`);
        } else {
          lines.push(`# ${key}=`);
        }
      }
    }

    // Model config
    lines.push("");
    lines.push("# Model configuration:");
    for (const key of modelKeys) {
      if (envMap.has(key)) {
        const value = envMap.get(key);
        if (value && value !== "") {
          lines.push(`${key}=${value}`);
        } else {
          lines.push(`# ${key}=`);
        }
      }
    }

    // Add any remaining keys that weren't categorized
    const categorizedKeys = new Set([...serverKeys, ...dbKeys, ...authKeys, ...modelKeys]);
    const remainingKeys = Array.from(envMap.keys()).filter(k => !categorizedKeys.has(k));
    if (remainingKeys.length > 0) {
      lines.push("");
      lines.push("# Other configuration:");
      for (const key of remainingKeys) {
        lines.push(`${key}=${envMap.get(key)}`);
      }
    }

    // Write to file with trailing newline
    writeFileSync(this.envPath, lines.join("\n") + "\n", "utf-8");
  }

  /**
   * Set API key in .env file
   */
  setApiKey(apiKey: string): void {
    const envMap = this.readEnvFile();

    // Set API key and clear OAuth token
    envMap.set("ANTHROPIC_API_KEY", apiKey);
    envMap.delete("CLAUDE_CODE_OAUTH_TOKEN");

    this.writeEnvFile(envMap);

    // Update current process environment
    process.env.ANTHROPIC_API_KEY = apiKey;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  /**
   * Set OAuth token in .env file
   */
  setOAuthToken(token: string): void {
    const envMap = this.readEnvFile();

    // Set OAuth token and clear API key
    envMap.set("CLAUDE_CODE_OAUTH_TOKEN", token);
    envMap.delete("ANTHROPIC_API_KEY");

    this.writeEnvFile(envMap);

    // Update current process environment
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Clear all credentials from .env file
   */
  clearCredentials(): void {
    const envMap = this.readEnvFile();

    // Remove both credentials
    envMap.delete("ANTHROPIC_API_KEY");
    envMap.delete("CLAUDE_CODE_OAUTH_TOKEN");

    this.writeEnvFile(envMap);

    // Update current process environment
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  /**
   * Get current API key from environment
   */
  getApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Get current OAuth token from environment
   */
  getOAuthToken(): string | undefined {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  /**
   * Check if any credentials are configured
   */
  hasCredentials(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }
}
