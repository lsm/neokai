import type { AuthMethod, AuthStatus, OAuthTokens } from "@liuboer/shared";
import type { Config } from "../config";
import { Database } from "../storage/database";
import { OAuthService } from "./oauth-service";

/**
 * AuthManager - Central authentication coordinator
 *
 * Manages both OAuth and API key authentication methods,
 * handles token refresh, and provides a unified interface for authentication.
 */
export class AuthManager {
  private oauth: OAuthService;
  private db: Database;
  private config: Config;
  private refreshInterval?: number;

  constructor(db: Database, config: Config) {
    this.db = db;
    this.config = config;
    this.oauth = new OAuthService(config);
  }

  /**
   * Initialize auth manager and start token refresh loop
   */
  async initialize(): Promise<void> {
    // Clean up expired OAuth states
    this.db.cleanupExpiredOAuthStates();

    // Start auto-refresh loop for OAuth tokens
    this.startTokenRefreshLoop();
  }

  /**
   * Get current authentication status
   */
  async getAuthStatus(): Promise<AuthStatus> {
    // Check for CLAUDE_CODE_OAUTH_TOKEN env var first (highest priority)
    if (this.config.claudeCodeOAuthToken) {
      return {
        method: "oauth_token",
        isAuthenticated: true,
        source: "env",
        user: {
          // Long-lived token from env (valid for 1 year)
        },
      };
    }

    const method = this.db.getAuthMethod();

    if (method === "none") {
      return {
        method: "none",
        isAuthenticated: false,
        source: "database",
      };
    }

    if (method === "api_key") {
      const apiKey = await this.db.getApiKey();
      return {
        method: "api_key",
        isAuthenticated: !!apiKey,
        source: "database",
      };
    }

    if (method === "oauth_token") {
      const token = await this.db.getOAuthLongLivedToken();
      return {
        method: "oauth_token",
        isAuthenticated: !!token,
        source: "database",
        user: {
          // Long-lived token from claude setup-token (valid for 1 year)
        },
      };
    }

    if (method === "oauth") {
      const tokens = await this.db.getOAuthTokens();
      if (!tokens) {
        return {
          method: "oauth",
          isAuthenticated: false,
          source: "database",
        };
      }

      return {
        method: "oauth",
        isAuthenticated: true,
        expiresAt: tokens.expiresAt,
        source: "database",
        user: {
          // Could fetch user info from Claude API in the future
        },
      };
    }

    return {
      method: "none",
      isAuthenticated: false,
      source: "database",
    };
  }

  /**
   * Start OAuth flow
   */
  async startOAuthFlow(): Promise<{ authorizationUrl: string; state: string }> {
    const { authorizationUrl, state, codeVerifier } = await this.oauth.startOAuthFlow();

    // Save state and verifier to database (expires in 10 minutes)
    this.db.saveOAuthState(state, codeVerifier, 10);

    return { authorizationUrl, state };
  }

  /**
   * Complete OAuth flow by exchanging code for tokens
   */
  async completeOAuthFlow(code: string, state: string): Promise<void> {
    // Retrieve and verify state
    const codeVerifier = this.db.getOAuthState(state);
    if (!codeVerifier) {
      throw new Error("Invalid or expired OAuth state");
    }

    // Exchange code for tokens
    const tokens = await this.oauth.exchangeCodeForToken(code, codeVerifier);

    // Save tokens to database
    await this.db.saveOAuthTokens(tokens);
  }

  /**
   * Set API key
   */
  async setApiKey(apiKey: string): Promise<void> {
    // TODO: Validate API key by making a test request to Anthropic
    await this.db.saveApiKey(apiKey);
  }

  /**
   * Set long-lived OAuth token (from claude setup-token)
   */
  async setOAuthToken(token: string): Promise<void> {
    await this.db.saveOAuthLongLivedToken(token);
  }

  /**
   * Get current API key (for use in agent sessions)
   */
  async getCurrentApiKey(): Promise<string | null> {
    // Priority 1: CLAUDE_CODE_OAUTH_TOKEN env var (highest priority)
    if (this.config.claudeCodeOAuthToken) {
      return this.config.claudeCodeOAuthToken;
    }

    const method = this.db.getAuthMethod();

    if (method === "api_key") {
      return await this.db.getApiKey();
    }

    if (method === "oauth_token") {
      // Return long-lived OAuth token
      return await this.db.getOAuthLongLivedToken();
    }

    if (method === "oauth") {
      // Get OAuth token and ensure it's not expired
      const tokens = await this.getValidOAuthToken();
      if (!tokens) return null;

      // Return access token (Claude Agent SDK accepts it via CLAUDE_CODE_OAUTH_TOKEN env var)
      return tokens.accessToken;
    }

    // Also check config for fallback API key
    if (this.config.anthropicApiKey) {
      return this.config.anthropicApiKey;
    }

    return null;
  }

  /**
   * Get valid OAuth token, refreshing if necessary
   */
  private async getValidOAuthToken(): Promise<OAuthTokens | null> {
    const tokens = await this.db.getOAuthTokens();
    if (!tokens) return null;

    // Check if token needs refresh
    if (this.oauth.shouldRefreshToken(tokens.expiresAt)) {
      try {
        const newTokens = await this.oauth.refreshAccessToken(tokens.refreshToken);
        await this.db.saveOAuthTokens(newTokens);
        return newTokens;
      } catch (error) {
        console.error("Failed to refresh OAuth token:", error);
        // Token refresh failed, clear auth
        this.db.clearAuth();
        return null;
      }
    }

    return tokens;
  }

  /**
   * Manually refresh OAuth token
   */
  async refreshToken(): Promise<number> {
    const tokens = await this.db.getOAuthTokens();
    if (!tokens) {
      throw new Error("No OAuth tokens to refresh");
    }

    const newTokens = await this.oauth.refreshAccessToken(tokens.refreshToken);
    await this.db.saveOAuthTokens(newTokens);
    return newTokens.expiresAt;
  }

  /**
   * Logout and clear authentication
   */
  logout(): void {
    this.db.clearAuth();
  }

  /**
   * Start automatic token refresh loop
   */
  private startTokenRefreshLoop(): void {
    // Check every 5 minutes
    this.refreshInterval = setInterval(async () => {
      const method = this.db.getAuthMethod();
      if (method === "oauth") {
        try {
          const tokens = await this.db.getOAuthTokens();
          if (tokens && this.oauth.shouldRefreshToken(tokens.expiresAt)) {
            console.log("Auto-refreshing OAuth token...");
            await this.refreshToken();
            console.log("✅ OAuth token refreshed successfully");
          }
        } catch (error) {
          console.error("Failed to auto-refresh token:", error);
        }
      }

      // Clean up expired OAuth states
      this.db.cleanupExpiredOAuthStates();
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop token refresh loop
   */
  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
