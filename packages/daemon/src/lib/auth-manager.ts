import type { AuthMethod, AuthStatus, OAuthTokens } from "@liuboer/shared";
import type { Config } from "../config";
import { Database } from "../storage/database";
import { OAuthService } from "./oauth-service";
import { EnvManager } from "./env-manager";

/**
 * AuthManager - Central authentication coordinator
 *
 * Manages both OAuth and API key authentication methods,
 * handles token refresh, and provides a unified interface for authentication.
 *
 * IMPORTANT: Credentials are NEVER stored in the database.
 * They are only stored in environment variables and the .env file.
 */
export class AuthManager {
  private oauth: OAuthService;
  private db: Database;
  private config: Config;
  private envManager: EnvManager;
  private refreshInterval?: number;

  constructor(db: Database, config: Config, envPath?: string) {
    this.db = db;
    this.config = config;
    this.oauth = new OAuthService(config);
    this.envManager = new EnvManager(envPath);
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
    // Check for OAuth token in env (highest priority)
    const oauthToken = this.envManager.getOAuthToken();
    if (oauthToken) {
      return {
        method: "oauth_token",
        isAuthenticated: true,
        source: "env",
        user: {
          // Long-lived token from env (valid for 1 year)
        },
      };
    }

    // Check for API key in env
    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return {
        method: "api_key",
        isAuthenticated: true,
        source: "env",
      };
    }

    // Check for OAuth flow tokens in database (temporary during OAuth flow)
    const method = this.db.getAuthMethod();
    if (method === "oauth") {
      const tokens = await this.db.getOAuthTokens();
      if (tokens) {
        return {
          method: "oauth",
          isAuthenticated: true,
          expiresAt: tokens.expiresAt,
          source: "database",
          user: {
            // OAuth flow tokens (short-lived, will be refreshed)
          },
        };
      }
    }

    // No authentication configured
    return {
      method: "none",
      isAuthenticated: false,
      source: "env",
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
   * Set API key - writes to .env file, NOT database
   */
  async setApiKey(apiKey: string): Promise<void> {
    // TODO: Validate API key by making a test request to Anthropic
    this.envManager.setApiKey(apiKey);

    // Clear any OAuth tokens from database
    this.db.clearAuth();
  }

  /**
   * Set long-lived OAuth token - writes to .env file, NOT database
   */
  async setOAuthToken(token: string): Promise<void> {
    this.envManager.setOAuthToken(token);

    // Clear any OAuth tokens from database
    this.db.clearAuth();
  }

  /**
   * Get current API key (for use in agent sessions)
   */
  async getCurrentApiKey(): Promise<string | null> {
    // Priority 1: OAuth token from env
    const oauthToken = this.envManager.getOAuthToken();
    if (oauthToken) {
      return oauthToken;
    }

    // Priority 2: API key from env
    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return apiKey;
    }

    // Priority 3: OAuth flow tokens (temporary, short-lived)
    const method = this.db.getAuthMethod();
    if (method === "oauth") {
      const tokens = await this.getValidOAuthToken();
      if (tokens) {
        // Return access token (Claude Agent SDK accepts it via CLAUDE_CODE_OAUTH_TOKEN env var)
        return tokens.accessToken;
      }
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
    // Clear credentials from .env file
    this.envManager.clearCredentials();

    // Clear any OAuth flow tokens from database
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
