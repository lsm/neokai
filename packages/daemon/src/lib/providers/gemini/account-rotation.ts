/**
 * Account Rotation System for Gemini Provider
 *
 * Manages multiple Google OAuth accounts with:
 * - Session-sticky affinity (once assigned, a session keeps its account)
 * - Failover on 429 rate limit errors
 * - Exhaustion detection with daily request counting
 * - Automatic cooldown period management
 * - Health checking on startup
 */

import { createLogger } from '@neokai/shared/logger';
import type { GoogleOAuthAccount } from './oauth-client.js';
import { loadAccounts, saveAccounts, updateAccount, validateRefreshToken } from './oauth-client.js';

const log = createLogger('kai:providers:gemini:rotation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session affinity map: sessionId → accountId. */
type SessionAccountMap = Map<string, string>;

/** Account rotation configuration. */
export interface RotationConfig {
	/** Default daily request limit per account. */
	dailyLimit: number;
	/** Cooldown duration in ms when an account hits rate limit (default: 60 seconds). */
	rateLimitCooldownMs: number;
	/** Exhaustion threshold: fraction of daily limit after which account is marked exhausted. */
	exhaustionThreshold: number;
	/** Whether to health-check accounts on startup. */
	healthCheckOnStartup: boolean;
}

/** Default rotation configuration. */
export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
	dailyLimit: 1500,
	rateLimitCooldownMs: 60_000, // 1 minute
	exhaustionThreshold: 0.9, // 90% of daily limit
	healthCheckOnStartup: true,
};

/** Storage backend interface — allows in-memory storage for testing. */
export interface AccountStorage {
	load(): Promise<GoogleOAuthAccount[]>;
	save(accounts: GoogleOAuthAccount[]): Promise<void>;
	update(accountId: string, updates: Partial<GoogleOAuthAccount>): Promise<void>;
}

/** Default file-based storage. */
class FileAccountStorage implements AccountStorage {
	async load(): Promise<GoogleOAuthAccount[]> {
		return loadAccounts();
	}
	async save(accounts: GoogleOAuthAccount[]): Promise<void> {
		return saveAccounts(accounts);
	}
	async update(accountId: string, updates: Partial<GoogleOAuthAccount>): Promise<void> {
		return updateAccount(accountId, updates);
	}
}

/** In-memory storage for testing. */
export class InMemoryAccountStorage implements AccountStorage {
	private accounts: GoogleOAuthAccount[] = [];

	async load(): Promise<GoogleOAuthAccount[]> {
		return [...this.accounts];
	}
	async save(accounts: GoogleOAuthAccount[]): Promise<void> {
		this.accounts = [...accounts];
	}
	async update(accountId: string, updates: Partial<GoogleOAuthAccount>): Promise<void> {
		const index = this.accounts.findIndex((a) => a.id === accountId);
		if (index === -1) return; // Silently skip in-memory
		this.accounts[index] = { ...this.accounts[index], ...updates };
	}
}

// ---------------------------------------------------------------------------
// Account Rotation Manager
// ---------------------------------------------------------------------------

export class AccountRotationManager {
	private sessionAccountMap: SessionAccountMap = new Map();
	private accounts: GoogleOAuthAccount[] = [];
	private config: RotationConfig;
	private storage: AccountStorage;
	private initialized = false;

	constructor(config?: Partial<RotationConfig>, storage?: AccountStorage) {
		this.config = { ...DEFAULT_ROTATION_CONFIG, ...config };
		this.storage = storage ?? new FileAccountStorage();
	}

	/**
	 * Initialize the rotation manager by loading accounts from storage.
	 * Optionally health-checks accounts to flag invalid ones.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		this.accounts = await this.storage.load();
		log.info(`Loaded ${this.accounts.length} Google OAuth accounts`);

		// Reset daily counters if they're from a previous day
		this.resetDayCountersIfNeeded();

		if (this.config.healthCheckOnStartup && this.accounts.length > 0) {
			await this.healthCheckAccounts();
		}

		this.initialized = true;
	}

	/**
	 * Get the account assigned to a session, or assign a new one.
	 *
	 * Session-sticky: once a session is assigned an account, it keeps it
	 * for the entire session. This avoids confusing the model's conversation state.
	 *
	 * @param sessionId - The session identifier
	 * @returns The account to use, or undefined if no accounts available
	 */
	async getAccountForSession(sessionId: string): Promise<GoogleOAuthAccount | undefined> {
		await this.initialize();

		// Check session affinity first
		const existingAccountId = this.sessionAccountMap.get(sessionId);
		if (existingAccountId) {
			const account = this.accounts.find((a) => a.id === existingAccountId);
			if (account && account.status === 'active' && !this.isInCooldown(account)) {
				await this.markUsed(account.id);
				return account;
			}
			// Account is exhausted/invalid — remove affinity and pick a new one
			this.sessionAccountMap.delete(sessionId);
			log.info(`Session ${sessionId} account ${existingAccountId} unavailable, reassigning`);
		}

		// Pick the best available account
		const account = this.pickBestAccount();
		if (!account) {
			log.warn('No available Google OAuth accounts for session');
			return undefined;
		}

		// Assign to session
		this.sessionAccountMap.set(sessionId, account.id);
		await this.markUsed(account.id);
		log.info(`Session ${sessionId} assigned to account ${account.email}`);
		return account;
	}

	/**
	 * Handle a 429 (rate limit) error for a specific account.
	 *
	 * Marks the account as exhausted for a cooldown period and removes
	 * any session affinities to it.
	 */
	async handleRateLimit(accountId: string): Promise<void> {
		const account = this.accounts.find((a) => a.id === accountId);
		if (!account) return;

		const cooldownUntil = Date.now() + this.config.rateLimitCooldownMs;
		log.warn(
			`Account ${account.email} hit rate limit. Cooling down until ${new Date(cooldownUntil).toISOString()}`
		);

		account.status = 'exhausted';
		account.cooldown_until = cooldownUntil;
		await this.storage.update(accountId, {
			status: 'exhausted',
			cooldown_until: cooldownUntil,
		});

		// Remove all session affinities for this account
		for (const [sessionId, accId] of this.sessionAccountMap.entries()) {
			if (accId === accountId) {
				this.sessionAccountMap.delete(sessionId);
				log.info(`Removed session ${sessionId} affinity to rate-limited account`);
			}
		}
	}

	/**
	 * Record a successful request for an account (for daily counting).
	 */
	async recordRequest(accountId: string): Promise<void> {
		const account = this.accounts.find((a) => a.id === accountId);
		if (!account) return;

		account.daily_request_count++;
		account.last_used_at = Date.now();

		// Check exhaustion threshold
		if (
			account.status === 'active' &&
			account.daily_request_count >=
				Math.floor(account.daily_limit * this.config.exhaustionThreshold)
		) {
			account.status = 'exhausted';
			log.warn(
				`Account ${account.email} approaching daily limit ` +
					`(${account.daily_request_count}/${account.daily_limit}), marking exhausted`
			);
		}

		await this.storage.update(accountId, {
			daily_request_count: account.daily_request_count,
			last_used_at: account.last_used_at,
			status: account.status,
		});
	}

	/**
	 * Mark an account as invalid (e.g., refresh token revoked).
	 */
	async markInvalid(accountId: string): Promise<void> {
		const account = this.accounts.find((a) => a.id === accountId);
		if (!account) return;

		account.status = 'invalid';
		await this.storage.update(accountId, { status: 'invalid' });

		// Remove session affinities
		for (const [sessionId, accId] of this.sessionAccountMap.entries()) {
			if (accId === accountId) {
				this.sessionAccountMap.delete(sessionId);
			}
		}

		log.warn(`Account ${account.email} marked as invalid`);
	}

	/**
	 * Force-reload accounts from storage, bypassing the initialized guard.
	 *
	 * Use this when accounts are modified externally (e.g., added or re-authed
	 * via the UI) so the in-memory pool picks up the latest data without
	 * requiring a daemon restart.
	 */
	async reload(): Promise<void> {
		this.accounts = await this.storage.load();
		this.resetDayCountersIfNeeded();
		log.info(`Reloaded ${this.accounts.length} Google OAuth accounts`);
	}

	/**
	 * Get all accounts with their current status.
	 */
	getAccounts(): GoogleOAuthAccount[] {
		return [...this.accounts];
	}

	/**
	 * Add a new account to the rotation pool.
	 */
	async addAccount(account: GoogleOAuthAccount): Promise<void> {
		await this.initialize();
		// Avoid duplicating if initialize() already loaded this account from storage
		if (!this.accounts.some((a) => a.id === account.id)) {
			this.accounts.push(account);
		}
	}

	/**
	 * Remove an account from the rotation pool.
	 */
	async removeAccount(accountId: string): Promise<void> {
		this.accounts = this.accounts.filter((a) => a.id !== accountId);

		// Remove session affinities
		for (const [sessionId, accId] of this.sessionAccountMap.entries()) {
			if (accId === accountId) {
				this.sessionAccountMap.delete(sessionId);
			}
		}
	}

	/**
	 * Get the number of active (non-exhausted, non-invalid) accounts.
	 */
	getActiveAccountCount(): number {
		return this.accounts.filter((a) => a.status === 'active' && !this.isInCooldown(a)).length;
	}

	/**
	 * Clean up session affinity when a session ends.
	 */
	releaseSession(sessionId: string): void {
		this.sessionAccountMap.delete(sessionId);
	}

	/**
	 * Get the session-to-account mapping (for debugging).
	 */
	getSessionMap(): Map<string, string> {
		return new Map(this.sessionAccountMap);
	}

	// ---------------------------------------------------------------------------
	// Private methods
	// ---------------------------------------------------------------------------

	/**
	 * Pick the best available account using least-recently-used strategy.
	 */
	private pickBestAccount(): GoogleOAuthAccount | undefined {
		const now = Date.now();

		// Filter to active accounts not in cooldown
		const available = this.accounts.filter(
			(a) => a.status === 'active' && !this.isInCooldown(a) && a.daily_request_count < a.daily_limit
		);

		if (available.length === 0) {
			// Try to recover accounts that are just in cooldown (not exhausted/invalid)
			const cooledDown = this.accounts.filter(
				(a) =>
					(a.status === 'active' || a.status === 'exhausted') &&
					a.cooldown_until > 0 &&
					a.cooldown_until <= now &&
					a.daily_request_count < a.daily_limit
			);

			if (cooledDown.length > 0) {
				// Recover the first cooled-down account
				const account = cooledDown[0];
				account.status = 'active';
				account.cooldown_until = 0;
				return account;
			}

			return undefined;
		}

		// Least-recently-used: sort by last_used_at ascending (oldest first)
		available.sort((a, b) => a.last_used_at - b.last_used_at);
		return available[0];
	}

	/**
	 * Check if an account is currently in cooldown.
	 */
	private isInCooldown(account: GoogleOAuthAccount): boolean {
		return account.cooldown_until > 0 && Date.now() < account.cooldown_until;
	}

	/**
	 * Mark an account as used (update last_used_at).
	 */
	private async markUsed(accountId: string): Promise<void> {
		const account = this.accounts.find((a) => a.id === accountId);
		if (!account) return;

		account.last_used_at = Date.now();
		// Don't persist every access — that would be too much I/O
		// The daily_request_count update handles persistence
	}

	/**
	 * Reset daily request counters if the day has changed.
	 */
	private resetDayCountersIfNeeded(): void {
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

		for (const account of this.accounts) {
			// If last_used_at is from a previous day, reset the counter
			const lastUsedDate = new Date(account.last_used_at).toISOString().slice(0, 10);
			if (lastUsedDate !== today && account.daily_request_count > 0) {
				log.info(
					`Resetting daily counter for ${account.email} (was ${account.daily_request_count})`
				);
				account.daily_request_count = 0;
				// Only reset to active if not invalid (revoked tokens stay invalid)
				if (account.status !== 'invalid') {
					account.status = 'active';
				}
				account.cooldown_until = 0;
			}
		}
	}

	/**
	 * Health-check all accounts by validating their refresh tokens.
	 * Invalid tokens are flagged as 'invalid'.
	 */
	private async healthCheckAccounts(): Promise<void> {
		log.info(`Health-checking ${this.accounts.length} accounts...`);

		const results = await Promise.allSettled(
			this.accounts.map(async (account) => {
				const isValid = await validateRefreshToken(account.refresh_token);
				return { account, isValid };
			})
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { account, isValid } = result.value;
				if (!isValid) {
					account.status = 'invalid';
					log.warn(`Account ${account.email} has invalid refresh token`);
				}
			}
		}

		// Persist updated statuses
		await this.storage.save(this.accounts);
	}
}
