/**
 * ProcessingStateManager Persistence Tests
 *
 * Tests for database persistence and state restoration:
 * - State persistence
 * - State restoration
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { Database } from '../../../../src/storage/database';
import { createTestDb, createTestDaemonHub, createTestSession } from './test-utils';

describe('ProcessingStateManager Persistence', () => {
	describe('state persistence', () => {
		let db: Database;
		let eventBus: DaemonHub;
		const sessionId = 'test-session-persist';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = await createTestDaemonHub('test-hub-persist');

			// Create a test session
			const session = createTestSession(sessionId);
			db.createSession(session);
		});

		it('should persist idle state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);

			await manager.setIdle();

			// Verify persisted to database
			const session = db.getSession(sessionId);
			expect(session).toBeDefined();
			expect(session!.processingState).toBeDefined();

			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('idle');
		});

		it('should persist queued state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-123';

			await manager.setQueued(messageId);

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('queued');
			expect(persistedState.messageId).toBe(messageId);
		});

		it('should persist processing state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-456';

			await manager.setProcessing(messageId, 'thinking');

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.messageId).toBe(messageId);
			expect(persistedState.phase).toBe('thinking');
		});

		it('should persist interrupted state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);

			await manager.setInterrupted();

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('interrupted');
		});

		it('should persist phase updates to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-789';

			// Start processing
			await manager.setProcessing(messageId, 'initializing');

			// Update phase
			await manager.updatePhase('streaming');

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('streaming');
			expect(persistedState.streamingStartedAt).toBeDefined();
		});

		it('should persist state changes through full lifecycle', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-lifecycle';

			// Start with idle
			await manager.setIdle();
			let session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('idle');

			// Move to queued
			await manager.setQueued(messageId);
			session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('queued');

			// Move to processing
			await manager.setProcessing(messageId, 'initializing');
			session = db.getSession(sessionId);
			let persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('initializing');

			// Update to streaming phase
			await manager.updatePhase('streaming');
			session = db.getSession(sessionId);
			persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.phase).toBe('streaming');

			// Back to idle
			await manager.setIdle();
			session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('idle');
		});
	});

	describe('state restoration', () => {
		let db: Database;
		let eventBus: DaemonHub;
		const sessionId = 'test-session-restore';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = await createTestDaemonHub('test-hub-restore');

			// Create a test session
			const session = createTestSession(sessionId);
			db.createSession(session);
		});

		it('should restore idle state from database', async () => {
			// Set up persisted state
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'idle' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should reset processing state to idle after restart (safety logic)', async () => {
			// Set up persisted processing state (simulating a crash during processing)
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'processing',
					messageId: 'msg-old',
					phase: 'streaming',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// After restart, processing should be reset to idle for safety
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should reset queued state to idle after restart (safety logic)', async () => {
			// Set up persisted queued state (simulating a crash during queued)
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'queued',
					messageId: 'msg-old',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// After restart, queued should be reset to idle for safety
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should restore interrupted state from database', async () => {
			// Set up persisted interrupted state
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'interrupted' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			const state = manager.getState();
			expect(state.status).toBe('interrupted');
		});

		it('should handle missing persisted state gracefully', async () => {
			// No persisted state in database
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// Should default to idle
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should handle invalid JSON in persisted state gracefully', async () => {
			// Set up invalid JSON in database
			db.updateSession(sessionId, {
				processingState: 'invalid-json-{',
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// Should default to idle when parsing fails
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});
	});
});
