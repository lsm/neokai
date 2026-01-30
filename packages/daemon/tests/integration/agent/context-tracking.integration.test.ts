/**
 * Integration tests for context tracking and broadcasting
 *
 * Tests the context window usage tracking flow:
 * Stream Event -> ContextTracker -> Persistence -> DaemonHub Event
 *
 * Test Coverage:
 * 1. Context info restoration after page refresh
 * 2. Context info broadcasting via DaemonHub
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { ContextInfo } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import { ContextTracker } from '../../../src/lib/agent/context-tracker';
import {
	setupIntegrationTestEnv,
	cleanupIntegrationTestEnv,
	createTestSession,
	type IntegrationTestEnv,
} from '../../integration-test-utils';

describe('Context Tracking Integration', () => {
	let env: IntegrationTestEnv;

	beforeEach(async () => {
		env = await setupIntegrationTestEnv();
	});

	afterEach(async () => {
		await cleanupIntegrationTestEnv(env);
	});

	describe('Page Refresh Context Restoration', () => {
		it('should restore context info and make it available immediately', async () => {
			const sessionId = generateUUID();

			// Create session with persisted context info
			const contextInfo: ContextInfo = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 50000,
				totalCapacity: 200000,
				percentUsed: 25,
				breakdown: {
					'System prompt': { tokens: 3000, percent: 1.5 },
					'System tools': { tokens: 15000, percent: 7.5 },
					Messages: { tokens: 32000, percent: 16 },
				},
				apiUsage: {
					inputTokens: 45000,
					outputTokens: 5000,
					cacheReadTokens: 10000,
					cacheCreationTokens: 5000,
				},
				source: 'merged',
				lastUpdated: Date.now(),
			};

			const session = createTestSession(env.testWorkspace, {
				id: sessionId,
				metadata: {
					messageCount: 10,
					totalTokens: 50000,
					inputTokens: 45000,
					outputTokens: 5000,
					totalCost: 0.25,
					toolCallCount: 15,
					lastContextInfo: contextInfo,
				},
			});

			env.db.createSession(session);

			// Reload session
			const reloadedSession = env.db.getSession(sessionId);
			expect(reloadedSession?.metadata.lastContextInfo).toBeDefined();
			expect(reloadedSession?.metadata.lastContextInfo?.totalUsed).toBe(50000);
			expect(reloadedSession?.metadata.lastContextInfo?.apiUsage?.inputTokens).toBe(45000);

			// Create ContextTracker with restored data
			const contextTracker = new ContextTracker(
				sessionId,
				session.config.model,
				env.daemonHub,
				(info: ContextInfo) => {
					session.metadata.lastContextInfo = info;
				}
			);

			// Restore from metadata
			if (reloadedSession?.metadata.lastContextInfo) {
				contextTracker.restoreFromMetadata(reloadedSession.metadata.lastContextInfo);
			}

			// Verify context info is immediately available
			const restoredContext = contextTracker.getContextInfo();
			expect(restoredContext).not.toBeNull();
			expect(restoredContext?.totalUsed).toBe(50000);
			expect(restoredContext?.breakdown['System prompt'].tokens).toBe(3000);
			expect(restoredContext?.apiUsage?.inputTokens).toBe(45000);
		});
	});

	describe('Context Info Broadcasting', () => {
		it('should update context and emit event via DaemonHub', async () => {
			const sessionId = generateUUID();

			// Create session
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('context.updated', (data) => {
				emittedEvents.push({ event: 'context.updated', data });
			});

			// Create ContextTracker with persistence callback
			const contextTracker = new ContextTracker(
				sessionId,
				session.config.model,
				env.daemonHub,
				(contextInfo: ContextInfo) => {
					session.metadata.lastContextInfo = contextInfo;
					env.db.updateSession(sessionId, { metadata: session.metadata });
				}
			);

			// Simulate stream event with usage
			const streamEvent = {
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 5000,
						output_tokens: 0,
					},
				},
			};

			await contextTracker.processStreamEvent(streamEvent as never);

			// Update with detailed breakdown
			const detailedContext: ContextInfo = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 5000,
				totalCapacity: 200000,
				percentUsed: 2.5,
				breakdown: {
					'System prompt': { tokens: 3000, percent: 1.5 },
					Messages: { tokens: 2000, percent: 1.0 },
				},
				apiUsage: {
					inputTokens: 5000,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
				},
				source: 'merged',
				lastUpdated: Date.now(),
			};

			contextTracker.updateWithDetailedBreakdown(detailedContext);

			// Verify context info was persisted to DB
			const updatedSession = env.db.getSession(sessionId);
			expect(updatedSession?.metadata.lastContextInfo).toBeDefined();
			expect(updatedSession?.metadata.lastContextInfo?.totalUsed).toBe(5000);

			// Verify DaemonHub emitted context.updated event
			// Note: processStreamEvent triggers throttled update, so we may need to wait
			await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for throttle

			expect(emittedEvents.length).toBeGreaterThan(0);
			const contextEvent = emittedEvents.find((e) => e.event === 'context.updated');
			expect(contextEvent).toBeDefined();
		});
	});
});
