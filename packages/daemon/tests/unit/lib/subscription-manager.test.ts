/**
 * Subscription Manager Tests
 *
 * Tests for client subscription management.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { SubscriptionManager } from '../../../src/lib/subscription-manager';
import type { MessageHub } from '@liuboer/shared';

describe('SubscriptionManager', () => {
	let mockMessageHub: MessageHub;
	let manager: SubscriptionManager;
	let subscriptions: Array<{ method: string; sessionId: string }>;

	beforeEach(() => {
		subscriptions = [];

		// Mock MessageHub
		mockMessageHub = {
			subscribe: mock(
				async (method: string, _handler: () => void, options?: { sessionId?: string }) => {
					subscriptions.push({ method, sessionId: options?.sessionId || 'global' });
					return () => {}; // Return unsubscribe function
				}
			),
		} as unknown as MessageHub;

		manager = new SubscriptionManager(mockMessageHub);
	});

	describe('subscribeToGlobalEvents', () => {
		it('should subscribe to all global events', async () => {
			await manager.subscribeToGlobalEvents('client-123');

			const expectedEvents = manager.getGlobalEventPatterns();

			expect(subscriptions).toHaveLength(expectedEvents.length);
			for (const event of expectedEvents) {
				expect(subscriptions.some((s) => s.method === event && s.sessionId === 'global')).toBe(
					true
				);
			}
		});

		it('should subscribe to session lifecycle events', async () => {
			await manager.subscribeToGlobalEvents('client-123');

			expect(subscriptions.some((s) => s.method === 'session.created')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'session.updated')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'session.deleted')).toBe(true);
		});

		it('should subscribe to state channel events', async () => {
			await manager.subscribeToGlobalEvents('client-123');

			expect(subscriptions.some((s) => s.method === 'state.sessions')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'state.sessions.delta')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'state.auth')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'state.config')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'state.health')).toBe(true);
		});
	});

	describe('subscribeToSessionEvents', () => {
		it('should subscribe to all session events', async () => {
			await manager.subscribeToSessionEvents('client-123', 'session-456');

			const expectedEvents = manager.getSessionEventPatterns();

			expect(subscriptions).toHaveLength(expectedEvents.length);
			for (const event of expectedEvents) {
				expect(subscriptions.some((s) => s.method === event && s.sessionId === 'session-456')).toBe(
					true
				);
			}
		});

		it('should subscribe with correct sessionId', async () => {
			await manager.subscribeToSessionEvents('client-123', 'my-session-id');

			for (const subscription of subscriptions) {
				expect(subscription.sessionId).toBe('my-session-id');
			}
		});

		it('should subscribe to agent communication events', async () => {
			await manager.subscribeToSessionEvents('client-123', 'session-456');

			expect(subscriptions.some((s) => s.method === 'context.updated')).toBe(true);
		});

		it('should subscribe to session status events', async () => {
			await manager.subscribeToSessionEvents('client-123', 'session-456');

			expect(subscriptions.some((s) => s.method === 'session.error')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'session.interrupted')).toBe(true);
		});

		it('should subscribe to SDK message events', async () => {
			await manager.subscribeToSessionEvents('client-123', 'session-456');

			expect(subscriptions.some((s) => s.method === 'state.sdkMessages')).toBe(true);
			expect(subscriptions.some((s) => s.method === 'state.sdkMessages.delta')).toBe(true);
		});
	});

	describe('unsubscribeFromSession', () => {
		it('should not throw when unsubscribing', async () => {
			// Should complete without throwing
			await manager.unsubscribeFromSession('client-123', 'session-456');
			// If we reach here, the test passes
			expect(true).toBe(true);
		});
	});

	describe('getGlobalEventPatterns', () => {
		it('should return list of global event patterns', () => {
			const patterns = manager.getGlobalEventPatterns();

			expect(patterns).toBeInstanceOf(Array);
			expect(patterns.length).toBeGreaterThan(0);
			expect(patterns).toContain('session.created');
			expect(patterns).toContain('state.sessions');
		});
	});

	describe('getSessionEventPatterns', () => {
		it('should return list of session event patterns', () => {
			const patterns = manager.getSessionEventPatterns();

			expect(patterns).toBeInstanceOf(Array);
			expect(patterns.length).toBeGreaterThan(0);
			expect(patterns).toContain('context.updated');
			expect(patterns).toContain('state.sdkMessages');
		});

		it('should not include sdk.message (removed in favor of delta)', () => {
			const patterns = manager.getSessionEventPatterns();

			expect(patterns).not.toContain('sdk.message');
		});
	});
});
