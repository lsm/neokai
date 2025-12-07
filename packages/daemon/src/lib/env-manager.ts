/**
 * EnvManager - Read-only access to environment variables
 *
 * Provides a simple interface to read authentication credentials
 * from environment variables. Does NOT support runtime modification.
 */
export class EnvManager {
	constructor(envPath?: string) {
		// envPath is kept for backward compatibility with tests but not used
		// All credentials are read from process.env only
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
