/**
 * Tests for Account Rotation System
 *
 * Tests session affinity, failover on 429, exhaustion detection, and cooldown.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
	AccountRotationManager,
	InMemoryAccountStorage,
	type RotationConfig,
} from '../../../../src/lib/providers/gemini/account-rotation.js';
import type { GoogleOAuthAccount } from '../../../../src/lib/providers/gemini/oauth-client.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestAccount(overrides: Partial<GoogleOAuthAccount> = {}): GoogleOAuthAccount {
	return {
		id: `acc-${Math.random().toString(36).slice(2, 8)}`,
		email: `test-${Math.random().toString(36).slice(2, 8)}@gmail.com`,
		refresh_token: '1//test-refresh-token',
		added_at: Date.now() - 86400000,
		last_used_at: 0,
		daily_request_count: 0,
		daily_limit: 1500,
		status: 'active',
		cooldown_until: 0,
		...overrides,
	};
}

function createManager(config?: Partial<RotationConfig>): AccountRotationManager {
	const storage = new InMemoryAccountStorage();
	return new AccountRotationManager({ healthCheckOnStartup: false, ...config }, storage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Account Rotation System', () => {
	describe('session affinity', () => {
		it('assigns the same account to a session across multiple calls', async () => {
			const manager = createManager();

			// Pre-populate accounts
			const acc1 = createTestAccount({ email: 'acc1@gmail.com' });
			const acc2 = createTestAccount({ email: 'acc2@gmail.com' });
			await manager.initialize();
			await manager.addAccount(acc1);
			await manager.addAccount(acc2);

			const session1 = 'session-1';

			// First call assigns an account
			const assigned1 = await manager.getAccountForSession(session1);
			expect(assigned1).toBeDefined();

			// Second call should return the same account
			const assigned2 = await manager.getAccountForSession(session1);
			expect(assigned2!.id).toBe(assigned1!.id);
		});

		it('different sessions can get different accounts', async () => {
			const manager = createManager();

			const acc1 = createTestAccount({ email: 'acc1@gmail.com' });
			const acc2 = createTestAccount({ email: 'acc2@gmail.com' });
			await manager.initialize();
			await manager.addAccount(acc1);
			await manager.addAccount(acc2);

			const s1 = await manager.getAccountForSession('session-1');
			const s2 = await manager.getAccountForSession('session-2');

			// Both should be assigned
			expect(s1).toBeDefined();
			expect(s2).toBeDefined();
		});

		it('releases session affinity on releaseSession', async () => {
			const manager = createManager();

			const acc = createTestAccount();
			await manager.initialize();
			await manager.addAccount(acc);

			const session = 'session-1';
			const assigned = await manager.getAccountForSession(session);
			expect(assigned).toBeDefined();

			// Check session map
			const map = manager.getSessionMap();
			expect(map.get(session)).toBe(assigned!.id);

			// Release
			manager.releaseSession(session);
			const mapAfter = manager.getSessionMap();
			expect(mapAfter.has(session)).toBe(false);
		});
	});

	describe('failover on 429', () => {
		it('marks account as exhausted and removes session affinity', async () => {
			const manager = createManager({ rateLimitCooldownMs: 5000 });

			const acc1 = createTestAccount({ email: 'acc1@gmail.com' });
			await manager.initialize();
			await manager.addAccount(acc1);

			const session = 'session-1';
			const assigned = await manager.getAccountForSession(session);
			expect(assigned!.id).toBe(acc1.id);

			// Simulate 429
			await manager.handleRateLimit(acc1.id);

			// Account should be exhausted
			const accounts = manager.getAccounts();
			expect(accounts.find((a) => a.id === acc1.id)!.status).toBe('exhausted');

			// Session affinity should be removed
			const map = manager.getSessionMap();
			expect(map.has(session)).toBe(false);
		});

		it('fails over to another account on 429', async () => {
			const manager = createManager({ rateLimitCooldownMs: 60000 });

			const acc1 = createTestAccount({ email: 'acc1@gmail.com' });
			const acc2 = createTestAccount({ email: 'acc2@gmail.com' });
			await manager.initialize();
			await manager.addAccount(acc1);
			await manager.addAccount(acc2);

			const session = 'session-1';

			// Assign to first account
			const first = await manager.getAccountForSession(session);
			expect(first).toBeDefined();

			// Rate limit it
			await manager.handleRateLimit(first!.id);

			// Should get a different account now
			const second = await manager.getAccountForSession(session);
			expect(second).toBeDefined();
			expect(second!.id).not.toBe(first!.id);
		});
	});

	describe('exhaustion detection', () => {
		it('marks account as exhausted when approaching daily limit', async () => {
			const manager = createManager({ exhaustionThreshold: 0.9 });

			const acc = createTestAccount({ daily_limit: 1500 });
			await manager.initialize();
			await manager.addAccount(acc);

			// Record requests up to threshold
			for (let i = 0; i < 1350; i++) {
				await manager.recordRequest(acc.id);
			}

			// Account should be exhausted
			const accounts = manager.getAccounts();
			expect(accounts.find((a) => a.id === acc.id)!.status).toBe('exhausted');
		});

		it('does not assign exhausted accounts to new sessions', async () => {
			const manager = createManager();

			const acc = createTestAccount({ status: 'exhausted' });
			await manager.initialize();
			await manager.addAccount(acc);

			const result = await manager.getAccountForSession('session-1');
			expect(result).toBeUndefined();
		});

		it('does not assign invalid accounts to new sessions', async () => {
			const manager = createManager();

			const acc = createTestAccount({ status: 'invalid' });
			await manager.initialize();
			await manager.addAccount(acc);

			const result = await manager.getAccountForSession('session-1');
			expect(result).toBeUndefined();
		});
	});

	describe('cooldown recovery', () => {
		it('recovers accounts after cooldown period', async () => {
			const manager = createManager({ rateLimitCooldownMs: 1 });

			const acc = createTestAccount();
			await manager.initialize();
			await manager.addAccount(acc);

			// Rate limit the account
			await manager.handleRateLimit(acc.id);

			// Should not be available immediately
			const accounts = manager.getAccounts();
			const exhausted = accounts.find((a) => a.id === acc.id)!;
			expect(exhausted.status).toBe('exhausted');
			expect(exhausted.cooldown_until).toBeGreaterThan(0);

			// Wait for cooldown
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should be available now
			const result = await manager.getAccountForSession('new-session');
			expect(result).toBeDefined();
			expect(result!.id).toBe(acc.id);
		});
	});

	describe('getActiveAccountCount', () => {
		it('returns count of active, non-cooled-down accounts', async () => {
			const manager = createManager();

			const acc1 = createTestAccount({ status: 'active' });
			const acc2 = createTestAccount({ status: 'active' });
			const acc3 = createTestAccount({ status: 'invalid' });
			const acc4 = createTestAccount({
				status: 'exhausted',
				cooldown_until: Date.now() + 60000,
			});

			await manager.initialize();
			await manager.addAccount(acc1);
			await manager.addAccount(acc2);
			await manager.addAccount(acc3);
			await manager.addAccount(acc4);

			expect(manager.getActiveAccountCount()).toBe(2);
		});
	});

	describe('markInvalid', () => {
		it('marks an account as invalid and removes session affinity', async () => {
			const manager = createManager();

			const acc = createTestAccount();
			await manager.initialize();
			await manager.addAccount(acc);

			// Assign to session
			await manager.getAccountForSession('session-1');
			expect(manager.getSessionMap().get('session-1')).toBe(acc.id);

			// Mark invalid
			await manager.markInvalid(acc.id);

			// Should be invalid
			const accounts = manager.getAccounts();
			expect(accounts.find((a) => a.id === acc.id)!.status).toBe('invalid');

			// Session affinity should be removed
			expect(manager.getSessionMap().has('session-1')).toBe(false);
		});
	});

	describe('removeAccount', () => {
		it('removes an account from the pool', async () => {
			const manager = createManager();

			const acc1 = createTestAccount({ email: 'acc1@gmail.com' });
			const acc2 = createTestAccount({ email: 'acc2@gmail.com' });
			await manager.initialize();
			await manager.addAccount(acc1);
			await manager.addAccount(acc2);

			expect(manager.getAccounts()).toHaveLength(2);

			await manager.removeAccount(acc1.id);

			expect(manager.getAccounts()).toHaveLength(1);
			expect(manager.getAccounts()[0].id).toBe(acc2.id);
		});
	});

	describe('daily counter reset', () => {
		it('resets counters for stale accounts on initialize', async () => {
			const storage = new InMemoryAccountStorage();

			// Create an account that was used yesterday
			const yesterday = Date.now() - 86400000 * 2;
			const acc = createTestAccount({
				daily_request_count: 1000,
				status: 'exhausted',
				last_used_at: yesterday,
			});

			// Pre-load the storage with the stale account
			await storage.save([acc]);

			const manager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);

			await manager.initialize();

			// After initialize, the counter should be reset
			const accounts = manager.getAccounts();
			const found = accounts.find((a) => a.id === acc.id)!;
			expect(found).toBeDefined();
			expect(found.daily_request_count).toBe(0);
			expect(found.status).toBe('active');
			expect(found.cooldown_until).toBe(0);
		});
	});

	describe('LRU selection', () => {
		it('picks least-recently-used account', async () => {
			const manager = createManager();

			const old = createTestAccount({
				email: 'old@gmail.com',
				last_used_at: 1000,
			});
			const recent = createTestAccount({
				email: 'recent@gmail.com',
				last_used_at: Date.now(),
			});

			await manager.initialize();
			await manager.addAccount(old);
			await manager.addAccount(recent);

			// Should pick the least recently used (oldest)
			const picked = await manager.getAccountForSession('session-1');
			expect(picked!.id).toBe(old.id);
		});
	});
});
