import type { OAuthTokens } from "@liuboer/shared";
import type { Config } from "../config";

/**
 * OAuth PKCE Service for Claude.ai authentication
 *
 * Implements OAuth 2.0 with PKCE (Proof Key for Code Exchange) flow
 * to authenticate users with their Claude Max/Pro subscription.
 */
export class OAuthService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Generate a cryptographically secure random string for PKCE
   */
  private generateRandomString(length: number): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Generate base64url encoded string
   */
  private base64urlEncode(buffer: ArrayBuffer): string {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  /**
   * Generate PKCE code verifier (random string)
   */
  private generateCodeVerifier(): string {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return this.base64urlEncode(randomBytes.buffer);
  }

  /**
   * Generate PKCE code challenge from verifier using SHA-256
   */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return this.base64urlEncode(hash);
  }

  /**
   * Start OAuth flow and generate authorization URL
   * Returns the URL to redirect user to and the state/verifier to store
   */
  async startOAuthFlow(): Promise<{
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
  }> {
    // Generate PKCE parameters
    const state = this.generateRandomString(32);
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.config.oauthClientId,
      response_type: "code",
      redirect_uri: this.config.oauthRedirectUri,
      scope: this.config.oauthScopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authorizationUrl = `${this.config.oauthAuthUrl}?${params.toString()}`;

    return {
      authorizationUrl,
      state,
      codeVerifier,
    };
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
  ): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.config.oauthClientId,
      redirect_uri: this.config.oauthRedirectUri,
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.config.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Liuboer-Daemon/1.0.0",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OAuth token exchange failed: ${error}`);
    }

    const data = await response.json();

    // Parse token response
    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000), // Convert to milliseconds
      scopes: data.scope ? data.scope.split(" ") : [],
      isMax: data.scope?.includes("user:inference") || false,
    };

    return tokens;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.oauthClientId,
    });

    const response = await fetch(this.config.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Liuboer-Daemon/1.0.0",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OAuth token refresh failed: ${error}`);
    }

    const data = await response.json();

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Some providers don't return new refresh token
      expiresAt: Date.now() + (data.expires_in * 1000),
      scopes: data.scope ? data.scope.split(" ") : [],
      isMax: data.scope?.includes("user:inference") || false,
    };

    return tokens;
  }

  /**
   * Validate if token needs refresh (check if expires within 5 minutes)
   */
  shouldRefreshToken(expiresAt: number): boolean {
    const fiveMinutesFromNow = Date.now() + (5 * 60 * 1000);
    return expiresAt < fiveMinutesFromNow;
  }
}
