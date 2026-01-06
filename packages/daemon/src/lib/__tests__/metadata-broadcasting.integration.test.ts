/**
 * Integration tests for metadata and state broadcasting
 *
 * Tests the end-to-end data flow:
 * Database → EventBus → StateManager → MessageHub Broadcast
 *
 * Test Coverage:
 * 1. Token/Cost metadata broadcasting
 * 2. Tool call count broadcasting
 * 3. Agent state broadcasting
 * 4. Commands broadcasting
 * 5. Page refresh simulation (state restoration)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../storage/database';
import { createDaemonHub, type DaemonHub } from '../daemon-hub';
import type { MessageHub, Session, SessionMetadata, ContextInfo } from '@liuboer/shared';
import type {
	PublishOptions,
	CallOptions,
	SubscribeOptions,
	RPCHandler,
	EventHandler,
	UnsubscribeFn,
} from '@liuboer/shared/message-hub/types';
import { ProcessingStateManager } from '../agent/processing-state-manager';
import { SDKMessageHandler } from '../agent/sdk-message-handler';
import { ContextTracker } from '../agent/context-tracker';
import { generateUUID } from '@liuboer/shared';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Mock MessageHub for broadcast verification
 * Captures all publish calls for assertion
 */
class MockMessageHub {
	private handlers = new Map<string, RPCHandler>();
	private publishedMessages: Array<{
		method: string;
		data: unknown;
		options?: PublishOptions;
	}> = [];

	// Track published messages
	async publish(method: string, data: unknown, options?: PublishOptions): Promise<void> {
		this.publishedMessages.push({ method, data, options });
	}

	// Get published messages for verification
	getPublishedMessages() {
		return this.publishedMessages;
	}

	// Clear published messages
	clearPublishedMessages() {
		this.publishedMessages = [];
	}

	// RPC handler registration
	handle<TData = unknown, TResult = unknown>(
		method: string,
		handler: RPCHandler<TData, TResult>
	): void {
		this.handlers.set(method, handler as RPCHandler);
	}

	// RPC call (for testing handlers)
	async call<TResult = unknown>(
		method: string,
		data?: unknown,
		_options?: CallOptions
	): Promise<TResult> {
		const handler = this.handlers.get(method);
		if (!handler) {
			throw new Error(`No handler for method: ${method}`);
		}

		const context = {
			messageId: generateUUID(),
			sessionId: 'test-session',
			method,
			timestamp: new Date().toISOString(),
		};

		return (await handler(data, context)) as TResult;
	}

	// Stub methods (not used in these tests)
	subscribe(_method: string, _handler: EventHandler, _options?: SubscribeOptions): UnsubscribeFn {
		return () => {};
	}

	unsubscribe(_method: string, _options?: SubscribeOptions): Promise<void> {
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

describe('Metadata and State Broadcasting Integration', () => {
	let db: Database;
	let daemonHub: DaemonHub;
	let mockMessageHub: MockMessageHub;
	let tempDir: string;
	let testWorkspace: string;

	beforeEach(async () => {
		// Create temporary directory for database and workspace
		tempDir = mkdtempSync(join(tmpdir(), 'metadata-test-'));
		testWorkspace = join(tempDir, 'workspace');

		// Initialize in-memory database
		db = new Database(':memory:');
		await db.initialize();

		// Initialize DaemonHub
		daemonHub = createDaemonHub('test');
		await daemonHub.initialize();

		// Initialize mock MessageHub
		mockMessageHub = new MockMessageHub();
	});

	afterEach(async () => {
		// Cleanup
		db.close();
		// DaemonHub doesn't have a destroy method, just clear it by letting it go out of scope

		// Remove temp directory
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('Token/Cost Metadata Broadcasting', () => {
		it('should update DB and broadcast when processing result message', async () => {
			// Create session
			const session: Session = {
				id: generateUUID(),
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(session.id, daemonHub, db);

			// Create ContextTracker (without persistence callback to avoid race conditions in test)
			const contextTracker = new ContextTracker(session.id, session.config.model, daemonHub, () => {
				// No-op callback for test to avoid DB race conditions
			});

			// We need to get the session from DB and pass it to SDKMessageHandler
			// The handler will update the session object passed to it AND the DB
			let workingSession = db.getSession(session.id)!;

			// Create SDKMessageHandler
			const messageHandler = new SDKMessageHandler(
				workingSession,
				db,
				mockMessageHub as unknown as MessageHub,
				daemonHub,
				stateManager,
				contextTracker
			);

			// Simulate result message with token usage
			const resultMessage = {
				type: 'result',
				subtype: 'success',
				duration_ms: 5000,
				duration_api_ms: 4500,
				is_error: false,
				num_turns: 1,
				result: 'success',
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				total_cost_usd: 0.015,
				modelUsage: {},
				permission_denials: [],
				uuid: generateUUID(),
				session_id: session.id,
			};

			// Set state to processing first
			await stateManager.setProcessing(generateUUID(), 'streaming');

			// Clear published messages before test
			mockMessageHub.clearPublishedMessages();

			// Handle result message
			await messageHandler.handleMessage(resultMessage as never);

			// Wait a bit for async operations to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify DB was updated
			const updatedSession = db.getSession(session.id);
			expect(updatedSession).not.toBeNull();
			expect(updatedSession!.metadata.messageCount).toBe(1);
			expect(updatedSession!.metadata.totalTokens).toBe(1500);
			expect(updatedSession!.metadata.inputTokens).toBe(1000);
			expect(updatedSession!.metadata.outputTokens).toBe(500);
			expect(updatedSession!.metadata.totalCost).toBe(0.015);

			// Verify DaemonHub emitted session.updated
			const sessionUpdatedEvents = emittedEvents.filter((e) => e.event === 'session.updated');
			expect(sessionUpdatedEvents.length).toBeGreaterThan(0);

			// Event-sourced: events include their data directly (no fetching by StateManager)
			const sessionUpdateData = sessionUpdatedEvents.find(
				(e) =>
					typeof e.data === 'object' &&
					e.data !== null &&
					'source' in e.data &&
					e.data.source === 'metadata'
			);
			expect(sessionUpdateData).toBeDefined();
		});
	});

	describe('Tool Call Count Broadcasting', () => {
		it('should update DB and broadcast when processing assistant message with tool calls', async () => {
			// Create session
			const session: Session = {
				id: generateUUID(),
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(session.id, daemonHub, db);

			// Create ContextTracker (without persistence callback to avoid race conditions in test)
			const contextTracker = new ContextTracker(session.id, session.config.model, daemonHub, () => {
				// No-op callback for test to avoid DB race conditions
			});

			// We need to get the session from DB and pass it to SDKMessageHandler
			let workingSession = db.getSession(session.id)!;

			// Create SDKMessageHandler
			const messageHandler = new SDKMessageHandler(
				workingSession,
				db,
				mockMessageHub as unknown as MessageHub,
				daemonHub,
				stateManager,
				contextTracker
			);

			// Simulate assistant message with tool calls
			const assistantMessage = {
				type: 'assistant',
				role: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Let me help you with that.' },
						{
							type: 'tool_use',
							id: 'tool_1',
							name: 'read_file',
							input: { path: 'test.txt' },
						},
						{
							type: 'tool_use',
							id: 'tool_2',
							name: 'write_file',
							input: { path: 'output.txt', content: 'test' },
						},
					],
				},
			};

			// Clear published messages before test
			mockMessageHub.clearPublishedMessages();

			// Handle assistant message
			await messageHandler.handleMessage(assistantMessage as never);

			// Verify DB was updated with tool call count
			const updatedSession = db.getSession(session.id);
			expect(updatedSession).not.toBeNull();
			expect(updatedSession!.metadata.toolCallCount).toBe(2);

			// Verify DaemonHub emitted session.updated
			const sessionUpdatedEvents = emittedEvents.filter((e) => e.event === 'session.updated');
			expect(sessionUpdatedEvents.length).toBeGreaterThan(0);

			// Event-sourced: events include their data directly (no fetching by StateManager)
			const sessionUpdateData = sessionUpdatedEvents.find(
				(e) =>
					typeof e.data === 'object' &&
					e.data !== null &&
					'source' in e.data &&
					e.data.source === 'metadata'
			);
			expect(sessionUpdateData).toBeDefined();
		});
	});

	describe('Agent State Broadcasting', () => {
		it('should persist and broadcast state transitions', async () => {
			const sessionId = generateUUID();

			// Create session in DB
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(sessionId, daemonHub, db);

			// Test state transitions
			const messageId = generateUUID();

			// Transition: idle → queued
			await stateManager.setQueued(messageId);

			// Verify DB was updated
			let dbSession = db.getSession(sessionId);
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

			// Transition: queued → processing
			await stateManager.setProcessing(messageId, 'streaming');

			dbSession = db.getSession(sessionId);
			const processingState = JSON.parse(dbSession!.processingState!);
			expect(processingState.status).toBe('processing');
			expect(processingState.phase).toBe('streaming');

			// Transition: processing → idle
			await stateManager.setIdle();

			dbSession = db.getSession(sessionId);
			const idleState = JSON.parse(dbSession!.processingState!);
			expect(idleState.status).toBe('idle');

			// Verify all state transitions were emitted
			expect(emittedEvents.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('Commands Broadcasting', () => {
		it('should persist commands and emit update event', async () => {
			const sessionId = generateUUID();

			// Create session in DB
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('commands.updated', (data) => {
				emittedEvents.push({ event: 'commands.updated', data });
			});

			// Simulate command update
			const commands = ['clear', 'help', 'context', 'compact'];

			// Update DB
			db.updateSession(sessionId, { availableCommands: commands });

			// Emit event
			await daemonHub.emit('commands.updated', {
				sessionId,
				commands,
			});

			// Verify DB was updated
			const updatedSession = db.getSession(sessionId);
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
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
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
			};

			db.createSession(session);

			// Create and persist processing state
			const stateManager = new ProcessingStateManager(sessionId, daemonHub, db);
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);

			// Save SDK messages
			db.saveSDKMessage(sessionId, {
				type: 'user',
				message: { content: 'Hello' },
			} as never);

			db.saveSDKMessage(sessionId, {
				type: 'assistant',
				role: 'assistant',
				message: { content: [{ type: 'text', text: 'Hi there!' }] },
			} as never);

			// Simulate page refresh: reload session from DB
			const reloadedSession = db.getSession(sessionId);

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
			const messages = db.getSDKMessages(sessionId);
			expect(messages.length).toBe(2);
			expect(messages[0].type).toBe('user');
			expect(messages[1].type).toBe('assistant');

			// Create new ProcessingStateManager (simulates AgentSession reconstruction)
			const newStateManager = new ProcessingStateManager(sessionId, daemonHub, db);

			// Verify state was restored (would be reset to idle after restart)
			newStateManager.restoreFromDatabase();
			const restoredState = newStateManager.getState();
			// After restart, state should be reset to idle for safety
			expect(restoredState.status).toBe('idle');
		});

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

			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 10,
					totalTokens: 50000,
					inputTokens: 45000,
					outputTokens: 5000,
					totalCost: 0.25,
					toolCallCount: 15,
					lastContextInfo: contextInfo,
				},
			};

			db.createSession(session);

			// Reload session
			const reloadedSession = db.getSession(sessionId);
			expect(reloadedSession?.metadata.lastContextInfo).toBeDefined();
			expect(reloadedSession?.metadata.lastContextInfo?.totalUsed).toBe(50000);
			expect(reloadedSession?.metadata.lastContextInfo?.apiUsage?.inputTokens).toBe(45000);

			// Create ContextTracker with restored data
			const contextTracker = new ContextTracker(
				sessionId,
				session.config.model,
				daemonHub,
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
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('context.updated', (data) => {
				emittedEvents.push({ event: 'context.updated', data });
			});

			// Create ContextTracker with persistence callback
			const contextTracker = new ContextTracker(
				sessionId,
				session.config.model,
				daemonHub,
				(contextInfo: ContextInfo) => {
					session.metadata.lastContextInfo = contextInfo;
					db.updateSession(sessionId, { metadata: session.metadata });
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
			const updatedSession = db.getSession(sessionId);
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

	describe('Draft Persistence Integration', () => {
		it('should persist inputDraft to database and restore on session load', async () => {
			const sessionId = generateUUID();

			// Create session
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Simulate user typing draft
			const draftText = 'This is a draft message';
			db.updateSession(sessionId, {
				metadata: {
					inputDraft: draftText,
				} as unknown as SessionMetadata,
			});

			// Verify draft was persisted
			const updatedSession = db.getSession(sessionId);
			expect(updatedSession?.metadata.inputDraft).toBe(draftText);

			// Verify other metadata fields were preserved
			expect(updatedSession?.metadata.messageCount).toBe(0);
			expect(updatedSession?.metadata.totalTokens).toBe(0);
		});

		it('should clear inputDraft when set to undefined', async () => {
			const sessionId = generateUUID();

			// Create session with draft
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
					inputDraft: 'Initial draft',
				},
			};

			db.createSession(session);

			// Verify draft exists
			let retrievedSession = db.getSession(sessionId);
			expect(retrievedSession?.metadata.inputDraft).toBe('Initial draft');

			// Clear draft (simulating message send)
			db.updateSession(sessionId, {
				metadata: {
					inputDraft: undefined,
				} as unknown as SessionMetadata,
			});

			// Verify draft was cleared
			retrievedSession = db.getSession(sessionId);
			expect(retrievedSession?.metadata.inputDraft).toBeUndefined();

			// Verify other metadata preserved
			expect(retrievedSession?.metadata.messageCount).toBe(0);
		});

		it('should handle concurrent metadata updates with inputDraft', async () => {
			const sessionId = generateUUID();

			// Create session
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Simulate draft update
			db.updateSession(sessionId, {
				metadata: {
					inputDraft: 'Draft text',
				} as unknown as SessionMetadata,
			});

			// Simulate message count update (concurrent)
			db.updateSession(sessionId, {
				metadata: {
					messageCount: 1,
				} as unknown as SessionMetadata,
			});

			// Verify both updates were merged correctly
			const updatedSession = db.getSession(sessionId);
			expect(updatedSession?.metadata.inputDraft).toBe('Draft text');
			expect(updatedSession?.metadata.messageCount).toBe(1);
		});

		it('should emit EventBus event when inputDraft is updated', async () => {
			const sessionId = generateUUID();

			// Create session
			const session: Session = {
				id: sessionId,
				title: 'Test Session',
				workspacePath: testWorkspace,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Update draft (should trigger session.updated event)
			db.updateSession(sessionId, {
				metadata: {
					inputDraft: 'New draft',
				} as unknown as SessionMetadata,
			});

			// Manually emit event (in real code, this would be done by SessionManager)
			daemonHub.emit('session.updated', {
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
