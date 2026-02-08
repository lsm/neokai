/**
 * Integration tests for SDK message metadata broadcasting
 *
 * Tests the end-to-end data flow for token/cost tracking:
 * Database -> DaemonHub -> StateManager -> MessageHub Broadcast
 *
 * Test Coverage:
 * 1. Token/Cost metadata broadcasting (result messages)
 * 2. Tool call count broadcasting (assistant messages)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import {
	SDKMessageHandler,
	type SDKMessageHandlerContext,
} from '../../../src/lib/agent/sdk-message-handler';
import { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { CheckpointTracker } from '../../../src/lib/agent/checkpoint-tracker';
import {
	setupIntegrationTestEnv,
	cleanupIntegrationTestEnv,
	createTestSession,
	type IntegrationTestEnv,
} from '../../helpers/integration-env';

describe('SDK Message Metadata Broadcasting', () => {
	let env: IntegrationTestEnv;

	beforeEach(async () => {
		env = await setupIntegrationTestEnv();
	});

	afterEach(async () => {
		await cleanupIntegrationTestEnv(env);
	});

	describe('Token/Cost Metadata Broadcasting', () => {
		it('should update DB and broadcast when processing result message', async () => {
			// Create session
			const session = createTestSession(env.testWorkspace);
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(session.id, env.daemonHub, env.db);

			// Create ContextTracker (without persistence callback to avoid race conditions in test)
			const contextTracker = new ContextTracker(
				session.id,
				session.config.model,
				env.daemonHub,
				() => {
					// No-op callback for test to avoid DB race conditions
				}
			);

			// We need to get the session from DB and pass it to SDKMessageHandler
			// The handler will update the session object passed to it AND the DB
			const workingSession = env.db.getSession(session.id)!;

			// Create mock MessageQueue
			const mockMessageQueue = {
				enqueue: mock(async () => generateUUID()),
			} as unknown as MessageQueue;

			// Create mock CheckpointTracker
			const mockCheckpointTracker = {
				processMessage: mock(() => {}),
				getCheckpoints: mock(() => []),
			} as unknown as CheckpointTracker;

			// Create SDKMessageHandler context
			const mockContext: SDKMessageHandlerContext = {
				session: workingSession,
				db: env.db,
				messageHub: env.mockMessageHub as unknown as MessageHub,
				daemonHub: env.daemonHub,
				stateManager,
				contextTracker,
				messageQueue: mockMessageQueue,
				checkpointTracker: mockCheckpointTracker,
				handleCircuitBreakerTrip: mock(async () => {}),
			};

			const messageHandler = new SDKMessageHandler(mockContext);

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
			env.mockMessageHub.clearPublishedMessages();

			// Handle result message
			await messageHandler.handleMessage(resultMessage as never);

			// Wait a bit for async operations to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify DB was updated
			const updatedSession = env.db.getSession(session.id);
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
			const session = createTestSession(env.testWorkspace);
			env.db.createSession(session);

			// Track DaemonHub emissions
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			env.daemonHub.on('session.updated', (data) => {
				emittedEvents.push({ event: 'session.updated', data });
			});

			// Create ProcessingStateManager
			const stateManager = new ProcessingStateManager(session.id, env.daemonHub, env.db);

			// Create ContextTracker (without persistence callback to avoid race conditions in test)
			const contextTracker = new ContextTracker(
				session.id,
				session.config.model,
				env.daemonHub,
				() => {
					// No-op callback for test to avoid DB race conditions
				}
			);

			// We need to get the session from DB and pass it to SDKMessageHandler
			const workingSession = env.db.getSession(session.id)!;

			// Create mock MessageQueue
			const mockMessageQueue = {
				enqueue: mock(async () => generateUUID()),
			} as unknown as MessageQueue;

			// Create mock CheckpointTracker
			const mockCheckpointTracker = {
				processMessage: mock(() => {}),
				getCheckpoints: mock(() => []),
			} as unknown as CheckpointTracker;

			// Create SDKMessageHandler context
			const mockContext: SDKMessageHandlerContext = {
				session: workingSession,
				db: env.db,
				messageHub: env.mockMessageHub as unknown as MessageHub,
				daemonHub: env.daemonHub,
				stateManager,
				contextTracker,
				messageQueue: mockMessageQueue,
				checkpointTracker: mockCheckpointTracker,
				handleCircuitBreakerTrip: mock(async () => {}),
			};

			const messageHandler = new SDKMessageHandler(mockContext);

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
			env.mockMessageHub.clearPublishedMessages();

			// Handle assistant message
			await messageHandler.handleMessage(assistantMessage as never);

			// Verify DB was updated with tool call count
			const updatedSession = env.db.getSession(session.id);
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
});
