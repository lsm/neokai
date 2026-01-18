/**
 * Integration tests for agent processing state broadcasting
 *
 * Tests the state machine transitions and persistence:
 * State Transition -> Database Persistence -> DaemonHub Event
 *
 * Test Coverage:
 * 1. Agent state transitions (idle -> queued -> processing -> idle)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { generateUUID } from '@liuboer/shared';
import { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import {
	setupIntegrationTestEnv,
	cleanupIntegrationTestEnv,
	createTestSession,
	type IntegrationTestEnv,
} from '../../integration-test-utils';

describe('Processing State Broadcasting', () => {
	let env: IntegrationTestEnv;

	beforeEach(async () => {
		env = await setupIntegrationTestEnv();
	});

	afterEach(async () => {
		await cleanupIntegrationTestEnv(env);
	});

	describe('Agent State Broadcasting', () => {
		it('should persist and broadcast state transitions', async () => {
			const sessionId = generateUUID();

			// Create session in DB
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(sessionId, env.daemonHub, env.db);

			// Test state transitions
			const messageId = generateUUID();

			// Transition: idle -> queued
			await stateManager.setQueued(messageId);

			// Verify DB was updated
			let dbSession = env.db.getSession(sessionId);
			expect(dbSession?.processingState).toBeDefined();
			const queuedState = JSON.parse(dbSession!.processingState!);
			expect(queuedState.status).toBe('queued');
			expect(queuedState.messageId).toBe(messageId);

			// Verify DaemonHub emitted session.updated with processing-state source
			expect(emittedEvents.length).toBeGreaterThan(0);
			const queuedEvent = emittedEvents.find(
				(e) =>
					e.event === 'session.updated' &&
					typeof e.data === 'object' &&
					e.data !== null &&
					'source' in e.data &&
					e.data.source === 'processing-state'
			);
			expect(queuedEvent).toBeDefined();

			// Transition: queued -> processing
			await stateManager.setProcessing(messageId, 'streaming');

			dbSession = env.db.getSession(sessionId);
			const processingState = JSON.parse(dbSession!.processingState!);
			expect(processingState.status).toBe('processing');
			expect(processingState.phase).toBe('streaming');

			// Transition: processing -> idle
			await stateManager.setIdle();

			dbSession = env.db.getSession(sessionId);
			const idleState = JSON.parse(dbSession!.processingState!);
			expect(idleState.status).toBe('idle');

			// Verify all state transitions were emitted
			expect(emittedEvents.length).toBeGreaterThanOrEqual(3);
		});
	});
});
