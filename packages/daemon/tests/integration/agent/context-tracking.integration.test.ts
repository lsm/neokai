/**
 * Integration tests for context tracking and persistence
 *
 * Tests the context window usage tracking flow:
 * /context command parsing -> ContextTracker -> Persistence -> Restoration
 *
 * Test Coverage:
 * 1. Context info persistence after /context command
 * 2. Context info restoration after page refresh
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
} from '../../helpers/integration-env';

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
				source: 'context-command',
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

			// Create ContextTracker with restored data
			const contextTracker = new ContextTracker(sessionId, (info: ContextInfo) => {
				session.metadata.lastContextInfo = info;
			});

			// Restore from metadata
			if (reloadedSession?.metadata.lastContextInfo) {
				contextTracker.restoreFromMetadata(reloadedSession.metadata.lastContextInfo);
			}

			// Verify context info is immediately available
			const restoredContext = contextTracker.getContextInfo();
			expect(restoredContext).not.toBeNull();
			expect(restoredContext?.totalUsed).toBe(50000);
			expect(restoredContext?.breakdown['System prompt'].tokens).toBe(3000);
		});
	});

	describe('Context Info Persistence', () => {
		it('should persist context info to DB when updated', async () => {
			const sessionId = generateUUID();

			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			const contextTracker = new ContextTracker(sessionId, (contextInfo: ContextInfo) => {
				session.metadata.lastContextInfo = contextInfo;
				env.db.updateSession(sessionId, { metadata: session.metadata });
			});

			const detailedContext: ContextInfo = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 5000,
				totalCapacity: 200000,
				percentUsed: 3,
				breakdown: {
					'System prompt': { tokens: 3000, percent: 1.5 },
					Messages: { tokens: 2000, percent: 1.0 },
				},
				source: 'context-command',
				lastUpdated: Date.now(),
			};

			contextTracker.updateWithDetailedBreakdown(detailedContext);

			// Verify context info was persisted to DB
			const updatedSession = env.db.getSession(sessionId);
			expect(updatedSession?.metadata.lastContextInfo).toBeDefined();
			expect(updatedSession?.metadata.lastContextInfo?.totalUsed).toBe(5000);
			expect(updatedSession?.metadata.lastContextInfo?.source).toBe('context-command');
		});
	});
});
