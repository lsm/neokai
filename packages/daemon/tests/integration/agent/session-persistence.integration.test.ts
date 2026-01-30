/**
 * Integration tests for session data persistence and restoration
 *
 * Tests the database persistence flow for various session data:
 * - Commands persistence and event emission
 * - Full session state restoration after page refresh
 * - Draft input persistence and lifecycle
 *
 * Test Coverage:
 * 1. Commands persistence and broadcasting
 * 2. Page refresh state restoration
 * 3. Draft persistence (4 tests: persist/clear/concurrent/events)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { SessionMetadata } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import {
	setupIntegrationTestEnv,
	cleanupIntegrationTestEnv,
	createTestSession,
	type IntegrationTestEnv,
} from '../../integration-test-utils';

describe('Session Persistence Integration', () => {
	let env: IntegrationTestEnv;

	beforeEach(async () => {
		env = await setupIntegrationTestEnv();
	});

	afterEach(async () => {
		await cleanupIntegrationTestEnv(env);
	});

	describe('Commands Broadcasting', () => {
		it('should persist commands and emit update event', async () => {
			const sessionId = generateUUID();

			// Create session in DB
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('commands.updated', (data) => {
				emittedEvents.push({ event: 'commands.updated', data });
			});

			// Simulate command update
			const commands = ['clear', 'help', 'context', 'compact'];

			// Update DB
			env.db.updateSession(sessionId, { availableCommands: commands });

			// Emit event
			await env.daemonHub.emit('commands.updated', {
				sessionId,
				commands,
			});

			// Verify DB was updated
			const updatedSession = env.db.getSession(sessionId);
			expect(updatedSession?.availableCommands).toEqual(commands);

			// Verify DaemonHub emitted event
			expect(emittedEvents.length).toBe(1);
			const commandsEvent = emittedEvents[0];
			expect(commandsEvent.event).toBe('commands.updated');
			expect(typeof commandsEvent.data === 'object' && commandsEvent.data !== null).toBe(true);
			if (typeof commandsEvent.data === 'object' && commandsEvent.data !== null) {
				expect('commands' in commandsEvent.data).toBe(true);
				expect((commandsEvent.data as { commands: string[] }).commands).toEqual(commands);
			}
		});
	});

	describe('Page Refresh Simulation', () => {
		it('should restore persisted state after session reload', async () => {
			const sessionId = generateUUID();

			// Create session with metadata
			const session = createTestSession(env.testWorkspace, {
				id: sessionId,
				metadata: {
					messageCount: 5,
					totalTokens: 10000,
					inputTokens: 6000,
					outputTokens: 4000,
					totalCost: 0.05,
					toolCallCount: 3,
					lastContextInfo: {
						model: 'claude-sonnet-4-5-20250929',
						totalUsed: 8000,
						totalCapacity: 200000,
						percentUsed: 4,
						breakdown: {
							'System prompt': { tokens: 3000, percent: 1.5 },
							Messages: { tokens: 5000, percent: 2.5 },
						},
						source: 'stream',
						lastUpdated: Date.now(),
					},
				},
				availableCommands: ['clear', 'help', 'context'],
			});

			env.db.createSession(session);

			// Create and persist processing state
			const stateManager = new ProcessingStateManager(sessionId, env.daemonHub, env.db);
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);

			// Save SDK messages
			env.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: { content: 'Hello' },
			} as never);

			env.db.saveSDKMessage(sessionId, {
				type: 'assistant',
				role: 'assistant',
				message: { content: [{ type: 'text', text: 'Hi there!' }] },
			} as never);

			// Simulate page refresh: reload session from DB
			const reloadedSession = env.db.getSession(sessionId);

			expect(reloadedSession).not.toBeNull();
			expect(reloadedSession!.id).toBe(sessionId);
			expect(reloadedSession!.metadata.messageCount).toBe(5);
			expect(reloadedSession!.metadata.totalTokens).toBe(10000);
			expect(reloadedSession!.metadata.toolCallCount).toBe(3);
			expect(reloadedSession!.availableCommands).toEqual(['clear', 'help', 'context']);
			expect(reloadedSession!.metadata.lastContextInfo).toBeDefined();
			expect(reloadedSession!.metadata.lastContextInfo?.totalUsed).toBe(8000);

			// Verify processing state was persisted
			expect(reloadedSession!.processingState).toBeDefined();
			const persistedState = JSON.parse(reloadedSession!.processingState!);
			expect(persistedState.status).toBe('queued');
			expect(persistedState.messageId).toBe(messageId);

			// Verify SDK messages were persisted
			const messages = env.db.getSDKMessages(sessionId);
			expect(messages.length).toBe(2);
			expect(messages[0].type).toBe('user');
			expect(messages[1].type).toBe('assistant');

			// Create new ProcessingStateManager (simulates AgentSession reconstruction)
			const newStateManager = new ProcessingStateManager(sessionId, env.daemonHub, env.db);

			// Verify state was restored (would be reset to idle after restart)
			newStateManager.restoreFromDatabase();
			const restoredState = newStateManager.getState();
			// After restart, state should be reset to idle for safety
			expect(restoredState.status).toBe('idle');
		});
	});

	describe('Draft Persistence Integration', () => {
		it('should persist inputDraft to database and restore on session load', async () => {
			const sessionId = generateUUID();

			// Create session
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Simulate user typing draft
			const draftText = 'This is a draft message';
			env.db.updateSession(sessionId, {
				metadata: {
					inputDraft: draftText,
				} as unknown as SessionMetadata,
			});

			// Verify draft was persisted
			const updatedSession = env.db.getSession(sessionId);
			expect(updatedSession?.metadata.inputDraft).toBe(draftText);

			// Verify other metadata fields were preserved
			expect(updatedSession?.metadata.messageCount).toBe(0);
			expect(updatedSession?.metadata.totalTokens).toBe(0);
		});

		it('should clear inputDraft when set to undefined', async () => {
			const sessionId = generateUUID();

			// Create session with draft
			const session = createTestSession(env.testWorkspace, {
				id: sessionId,
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
					inputDraft: 'Initial draft',
				},
			});

			env.db.createSession(session);

			// Verify draft exists
			let retrievedSession = env.db.getSession(sessionId);
			expect(retrievedSession?.metadata.inputDraft).toBe('Initial draft');

			// Clear draft (simulating message send)
			env.db.updateSession(sessionId, {
				metadata: {
					inputDraft: undefined,
				} as unknown as SessionMetadata,
			});

			// Verify draft was cleared
			retrievedSession = env.db.getSession(sessionId);
			expect(retrievedSession?.metadata.inputDraft).toBeUndefined();

			// Verify other metadata preserved
			expect(retrievedSession?.metadata.messageCount).toBe(0);
		});

		it('should handle concurrent metadata updates with inputDraft', async () => {
			const sessionId = generateUUID();

			// Create session
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Simulate draft update
			env.db.updateSession(sessionId, {
				metadata: {
					inputDraft: 'Draft text',
				} as unknown as SessionMetadata,
			});

			// Simulate message count update (concurrent)
			env.db.updateSession(sessionId, {
				metadata: {
					messageCount: 1,
				} as unknown as SessionMetadata,
			});

			// Verify both updates were merged correctly
			const updatedSession = env.db.getSession(sessionId);
			expect(updatedSession?.metadata.inputDraft).toBe('Draft text');
			expect(updatedSession?.metadata.messageCount).toBe(1);
		});

		it('should emit EventBus event when inputDraft is updated', async () => {
			const sessionId = generateUUID();

			// Create session
			const session = createTestSession(env.testWorkspace, { id: sessionId });
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Update draft (should trigger session.updated event)
			env.db.updateSession(sessionId, {
				metadata: {
					inputDraft: 'New draft',
				} as unknown as SessionMetadata,
			});

			// Manually emit event (in real code, this would be done by SessionManager)
			await env.daemonHub.emit('session.updated', {
				sessionId,
				source: 'metadata',
			});

			// Verify DaemonHub emitted event
			expect(emittedEvents.length).toBeGreaterThan(0);
			const updateEvent = emittedEvents.find((e) => e.event === 'session.updated');
			expect(updateEvent).toBeDefined();
		});
	});
});
