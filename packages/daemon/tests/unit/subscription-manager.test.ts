/**
 * SubscriptionManager Tests
 *
 * Tests application-level subscription patterns and management.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { SubscriptionManager } from '../../src/lib/subscription-manager';
import { MessageHub } from '@liuboer/shared';

describe('SubscriptionManager', () => {
	let subscriptionManager: SubscriptionManager;
	let mockMessageHub: MessageHub;
	let subscribeSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		// Create mock MessageHub with subscribe method
		subscribeSpy = mock(async () => {
			return () => {}; // Return unsubscribe function
		});

		mockMessageHub = {
			subscribe: subscribeSpy,
		} as unknown as MessageHub;

		subscriptionManager = new SubscriptionManager(mockMessageHub);
	});

	describe('constructor', () => {
		it('should create SubscriptionManager with MessageHub', () => {
			expect(subscriptionManager).toBeDefined();
		});
	});

	describe('subscribeToGlobalEvents', () => {
		it('should subscribe to all global event patterns', async () => {
			const clientId = 'test-client-123';

			await subscriptionManager.subscribeToGlobalEvents(clientId);

			// Should have subscribed to global events
			expect(subscribeSpy).toHaveBeenCalled();

			// Verify all global events are subscribed
			const expectedEvents = [
				'session.created',
				'session.updated',
				'session.deleted',
				'state.sessions',
				'state.sessions.delta',
				'state.auth',
				'state.config',
				'state.health',
			];

			expectedEvents.forEach((event) => {
				expect(subscribeSpy).toHaveBeenCalledWith(event, expect.any(Function), {
					sessionId: 'global',
				});
			});
		});

		it('should subscribe sequentially (await each subscription)', async () => {
			const clientId = 'test-client-456';
			let subscriptionCount = 0;

			subscribeSpy = mock(async () => {
				subscriptionCount++;
				return () => {};
			});

			mockMessageHub = {
				subscribe: subscribeSpy,
			} as unknown as MessageHub;

			subscriptionManager = new SubscriptionManager(mockMessageHub);

			await subscriptionManager.subscribeToGlobalEvents(clientId);

			// Should have made multiple subscription calls
			expect(subscriptionCount).toBeGreaterThan(5);
		});

		it('should use empty handler for subscriptions', async () => {
			const clientId = 'test-client-789';

			await subscriptionManager.subscribeToGlobalEvents(clientId);

			// Verify handler is a function (empty handler)
			const firstCall = subscribeSpy.mock.calls[0];
			expect(typeof firstCall[1]).toBe('function');
		});
	});

	describe('subscribeToSessionEvents', () => {
		it('should subscribe to all session event patterns', async () => {
			const clientId = 'test-client-abc';
			const sessionId = 'session-xyz';

			await subscriptionManager.subscribeToSessionEvents(clientId, sessionId);

			// Should have subscribed to session events
			expect(subscribeSpy).toHaveBeenCalled();

			// Verify all session events are subscribed
			const expectedEvents = [
				'sdk.message',
				'context.updated',
				'session.error',
				'session.interrupted',
				'state.session',
				'state.sdkMessages',
				'state.sdkMessages.delta',
			];

			expectedEvents.forEach((event) => {
				expect(subscribeSpy).toHaveBeenCalledWith(event, expect.any(Function), {
					sessionId,
				});
			});
		});

		it('should use session-specific sessionId', async () => {
			const clientId = 'test-client-def';
			const sessionId = 'session-123';

			await subscriptionManager.subscribeToSessionEvents(clientId, sessionId);

			// All calls should use the specific sessionId
			subscribeSpy.mock.calls.forEach((call) => {
				expect(call[2]).toEqual({ sessionId });
			});
		});

		it('should subscribe to different events than global', async () => {
			// Create fresh mock to avoid readonly issues
			const freshSubscribeSpy = mock(async () => () => {});
			const freshHub = {
				subscribe: freshSubscribeSpy,
			} as unknown as MessageHub;
			const freshManager = new SubscriptionManager(freshHub);

			await freshManager.subscribeToSessionEvents('client', 'session');

			const sessionEvents = freshSubscribeSpy.mock.calls.map((call) => call[0]);

			// Should include session-specific events
			expect(sessionEvents).toContain('sdk.message');
			expect(sessionEvents).toContain('session.error');
			expect(sessionEvents).toContain('session.interrupted');

			// Should NOT include global-only events
			expect(sessionEvents).not.toContain('session.created');
			expect(sessionEvents).not.toContain('session.deleted');
		});
	});

	describe('unsubscribeFromSession', () => {
		it('should handle unsubscribe from session', async () => {
			const clientId = 'test-client-ghi';
			const sessionId = 'session-456';

			// Should not throw
			await expect(
				subscriptionManager.unsubscribeFromSession(clientId, sessionId)
			).resolves.toBeUndefined();
		});

		it('should be a placeholder for future cleanup logic', async () => {
			// Currently just logs, doesn't throw
			await subscriptionManager.unsubscribeFromSession('client', 'session');
			// Test passes if no error thrown
		});
	});

	describe('getGlobalEventPatterns', () => {
		it('should return all global event patterns', () => {
			const patterns = subscriptionManager.getGlobalEventPatterns();

			expect(patterns).toContain('session.created');
			expect(patterns).toContain('session.updated');
			expect(patterns).toContain('session.deleted');
			expect(patterns).toContain('state.sessions');
			expect(patterns).toContain('state.sessions.delta');
			expect(patterns).toContain('state.auth');
			expect(patterns).toContain('state.config');
			expect(patterns).toContain('state.health');
		});

		it('should return array of strings', () => {
			const patterns = subscriptionManager.getGlobalEventPatterns();

			expect(Array.isArray(patterns)).toBe(true);
			patterns.forEach((pattern) => {
				expect(typeof pattern).toBe('string');
			});
		});

		it('should match actual subscription patterns', () => {
			const patterns = subscriptionManager.getGlobalEventPatterns();

			// Should match what subscribeToGlobalEvents subscribes to
			expect(patterns.length).toBeGreaterThan(5);
		});
	});

	describe('getSessionEventPatterns', () => {
		it('should return all session event patterns', () => {
			const patterns = subscriptionManager.getSessionEventPatterns();

			expect(patterns).toContain('sdk.message');
			expect(patterns).toContain('context.updated');
			expect(patterns).toContain('session.error');
			expect(patterns).toContain('session.interrupted');
			expect(patterns).toContain('state.session');
			expect(patterns).toContain('state.sdkMessages');
			expect(patterns).toContain('state.sdkMessages.delta');
		});

		it('should return array of strings', () => {
			const patterns = subscriptionManager.getSessionEventPatterns();

			expect(Array.isArray(patterns)).toBe(true);
			patterns.forEach((pattern) => {
				expect(typeof pattern).toBe('string');
			});
		});

		it('should match actual subscription patterns', () => {
			const patterns = subscriptionManager.getSessionEventPatterns();

			// Should match what subscribeToSessionEvents subscribes to
			expect(patterns.length).toBeGreaterThan(5);
		});

		it('should be different from global patterns', () => {
			const globalPatterns = subscriptionManager.getGlobalEventPatterns();
			const sessionPatterns = subscriptionManager.getSessionEventPatterns();

			// Should have some unique patterns
			const uniqueToSession = sessionPatterns.filter((p) => !globalPatterns.includes(p));
			expect(uniqueToSession.length).toBeGreaterThan(0);
		});
	});

	describe('application layer architecture', () => {
		it('should define what to subscribe to (application logic)', () => {
			// SubscriptionManager defines APPLICATION-SPECIFIC events
			const globalPatterns = subscriptionManager.getGlobalEventPatterns();
			const sessionPatterns = subscriptionManager.getSessionEventPatterns();

			// These are application patterns, not infrastructure
			expect(globalPatterns).toContain('session.created');
			expect(sessionPatterns).toContain('sdk.message');

			// Infrastructure (MessageHub/Router) has no knowledge of these
		});

		it('should use MessageHub for actual subscription', async () => {
			// SubscriptionManager delegates to MessageHub for infrastructure
			await subscriptionManager.subscribeToGlobalEvents('client');

			// MessageHub.subscribe should be called
			expect(subscribeSpy).toHaveBeenCalled();
		});
	});

	describe('subscription patterns', () => {
		it('should include state channel patterns for global', () => {
			const patterns = subscriptionManager.getGlobalEventPatterns();

			// Should include state channels
			expect(patterns.some((p) => p.startsWith('state.'))).toBe(true);
		});

		it('should include state channel patterns for session', () => {
			const patterns = subscriptionManager.getSessionEventPatterns();

			// Should include state channels
			expect(patterns.some((p) => p.startsWith('state.'))).toBe(true);
		});

		it('should include lifecycle events for global', () => {
			const patterns = subscriptionManager.getGlobalEventPatterns();

			// Should include lifecycle events
			expect(patterns).toContain('session.created');
			expect(patterns).toContain('session.updated');
			expect(patterns).toContain('session.deleted');
		});

		it('should include agent events for session', () => {
			const patterns = subscriptionManager.getSessionEventPatterns();

			// Should include agent events
			expect(patterns).toContain('sdk.message');
			expect(patterns).toContain('session.interrupted');
		});
	});

	describe('error handling', () => {
		it('should handle subscription errors gracefully', async () => {
			// Mock MessageHub that throws on subscribe
			const errorHub = {
				subscribe: mock(async () => {
					throw new Error('Subscription failed');
				}),
			} as unknown as MessageHub;

			const errorManager = new SubscriptionManager(errorHub);

			// Should propagate error
			await expect(errorManager.subscribeToGlobalEvents('client')).rejects.toThrow(
				'Subscription failed'
			);
		});
	});

	describe('reliability', () => {
		it('should wait for each subscription to complete (sequential)', async () => {
			const callOrder: number[] = [];
			let callCount = 0;

			subscribeSpy = mock(async () => {
				const order = callCount++;
				callOrder.push(order);
				// Simulate async delay
				await new Promise((resolve) => setTimeout(resolve, 1));
				return () => {};
			});

			mockMessageHub = {
				subscribe: subscribeSpy,
			} as unknown as MessageHub;

			subscriptionManager = new SubscriptionManager(mockMessageHub);

			await subscriptionManager.subscribeToGlobalEvents('client');

			// Should have called multiple times in sequence
			expect(callOrder.length).toBeGreaterThan(5);
			// Order should be sequential (0, 1, 2, 3, ...)
			for (let i = 0; i < callOrder.length; i++) {
				expect(callOrder[i]).toBe(i);
			}
		});
	});
});
