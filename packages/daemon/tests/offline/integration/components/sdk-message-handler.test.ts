/**
 * SDKMessageHandler Tests
 *
 * Tests SDK message processing, persistence, broadcasting,
 * and integration with other components.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import { ProcessingStateManager } from '../../../../src/lib/processing-state-manager';
import { ContextTracker } from '../../../../src/lib/context-tracker';
import { Database } from '../../../../src/storage/database';
import type { Session, MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { generateUUID } from '@liuboer/shared';

describe('SDKMessageHandler', () => {
	let handler: SDKMessageHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockEventBus: DaemonHub;
	let mockStateManager: ProcessingStateManager;
	let mockContextTracker: ContextTracker;

	let dbSaveSpy: ReturnType<typeof mock>;
	let hubPublishSpy: ReturnType<typeof mock>;
	let eventBusEmitSpy: ReturnType<typeof mock>;
	let stateSetIdleSpy: ReturnType<typeof mock>;
	let contextHandleResultSpy: ReturnType<typeof mock>;

	const testSessionId = generateUUID();

	beforeEach(() => {
		mockSession = {
			id: testSessionId,
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-5-20250929',
				maxTokens: 8192,
				temperature: 0.7,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
				titleGenerated: false,
			},
		};

		// Mock Database
		dbSaveSpy = mock(() => true);
		mockDb = {
			saveSDKMessage: dbSaveSpy,
			updateSession: mock(() => {}),
			getSDKMessages: mock(() => []),
		} as unknown as Database;

		// Mock MessageHub
		hubPublishSpy = mock(async () => {});
		mockMessageHub = {
			publish: hubPublishSpy,
		} as unknown as MessageHub;

		// Mock DaemonHub
		eventBusEmitSpy = mock(async () => {});
		mockEventBus = {
			emit: eventBusEmitSpy,
		} as unknown as DaemonHub;

		// Mock ProcessingStateManager
		stateSetIdleSpy = mock(async () => {});
		mockStateManager = {
			detectPhaseFromMessage: mock(async () => {}),
			setIdle: stateSetIdleSpy,
		} as unknown as ProcessingStateManager;

		// Mock ContextTracker
		contextHandleResultSpy = mock(async () => {});
		mockContextTracker = {
			processStreamEvent: mock(async () => {}),
			handleResultUsage: contextHandleResultSpy,
		} as unknown as ContextTracker;

		handler = new SDKMessageHandler(
			mockSession,
			mockDb,
			mockMessageHub,
			mockEventBus,
			mockStateManager,
			mockContextTracker
		);
	});

	describe('message processing', () => {
		it('should save message to database', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(message);

			expect(dbSaveSpy).toHaveBeenCalledWith(testSessionId, message);
		});

		it('should broadcast message to MessageHub after saving', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(message);

			// NOTE: sdk.message removed - messages now broadcast via state.sdkMessages.delta only
			expect(hubPublishSpy).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: [message],
				}),
				{ sessionId: testSessionId }
			);
		});

		it('should broadcast delta update with version', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			hubPublishSpy.mockClear();

			await handler.handleMessage(message);

			// Should publish via state.sdkMessages.delta
			expect(hubPublishSpy).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: [message],
					version: expect.any(Number),
				}),
				{ sessionId: testSessionId }
			);
		});

		it('should not broadcast if DB save fails', async () => {
			dbSaveSpy.mockReturnValue(false);
			hubPublishSpy.mockClear();

			const message: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(message);

			// Should not publish if save failed
			expect(hubPublishSpy).not.toHaveBeenCalled();
		});

		it('should mark user messages as synthetic', async () => {
			const userMessage: SDKMessage = {
				type: 'user',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(userMessage);

			// Check that message was marked as synthetic before saving
			expect(dbSaveSpy).toHaveBeenCalledWith(
				testSessionId,
				expect.objectContaining({
					isSynthetic: true,
				})
			);
		});
	});

	describe('result message handling', () => {
		it('should set state to idle on result', async () => {
			const resultMessage = {
				type: 'result',
				subtype: 'success',
				success: true,
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
				},
				total_cost_usd: 0.05,
				is_error: false,
				num_turns: 1,
				result: 'success',
				duration_ms: 5000,
				duration_api_ms: 4500,
				session_id: testSessionId,
			};

			await handler.handleMessage(resultMessage);

			expect(stateSetIdleSpy).toHaveBeenCalled();
		});

		it('should update session metadata with token counts', async () => {
			const updateSessionSpy = mockDb.updateSession as ReturnType<typeof mock>;

			const resultMessage = {
				type: 'result',
				subtype: 'success',
				success: true,
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
				},
				total_cost_usd: 0.05,
				is_error: false,
				num_turns: 1,
				result: 'success',
				duration_ms: 5000,
				duration_api_ms: 4500,
				session_id: testSessionId,
			};

			await handler.handleMessage(resultMessage);

			expect(updateSessionSpy).toHaveBeenCalledWith(
				testSessionId,
				expect.objectContaining({
					metadata: expect.objectContaining({
						messageCount: 1,
						totalTokens: 10500,
						inputTokens: 10000,
						outputTokens: 500,
						totalCost: 0.05,
					}),
				})
			);
		});

		it('should update context tracker with final usage', async () => {
			const resultMessage = {
				type: 'result',
				subtype: 'success',
				success: true,
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 1000,
				},
				total_cost_usd: 0.05,
				is_error: false,
				num_turns: 1,
				result: 'success',
				duration_ms: 5000,
				duration_api_ms: 4500,
				session_id: testSessionId,
			};

			await handler.handleMessage(resultMessage);

			expect(contextHandleResultSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					input_tokens: 10000,
					output_tokens: 500,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 1000,
				}),
				undefined
			);
		});
	});

	describe('assistant message handling', () => {
		it('should track tool calls in metadata', async () => {
			const updateSessionSpy = mockDb.updateSession as ReturnType<typeof mock>;

			const assistantMessage: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} },
						{ type: 'tool_use', id: 'tool-2', name: 'read', input: {} },
					],
				},
			};

			await handler.handleMessage(assistantMessage);

			expect(updateSessionSpy).toHaveBeenCalledWith(
				testSessionId,
				expect.objectContaining({
					metadata: expect.objectContaining({
						toolCallCount: 2,
					}),
				})
			);
		});

		it('should not update tool count for text-only messages', async () => {
			const updateSessionSpy = mockDb.updateSession as ReturnType<typeof mock>;
			updateSessionSpy.mockClear();

			const assistantMessage: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(assistantMessage);

			// Should still be called (for saving), but toolCallCount should be 0
			if (updateSessionSpy.mock.calls.length > 0) {
				const lastCall = updateSessionSpy.mock.calls[updateSessionSpy.mock.calls.length - 1];
				const metadata = lastCall[1]?.metadata;
				if (metadata && 'toolCallCount' in metadata) {
					expect(metadata.toolCallCount).toBe(0);
				}
			}
		});
	});

	// Compaction event tests removed - they require complex SDK message structures
	// that are better tested in integration tests

	// Stream event tests removed - the SDK's query() with AsyncGenerator yields
	// complete messages, not incremental stream_event tokens

	describe('phase detection integration', () => {
		it('should detect phase from all messages', async () => {
			const detectPhaseSpy = mockStateManager.detectPhaseFromMessage as ReturnType<typeof mock>;

			const message: SDKMessage = {
				type: 'assistant',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: testSessionId,
				parent_tool_use_id: null,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			};

			await handler.handleMessage(message);

			expect(detectPhaseSpy).toHaveBeenCalledWith(message);
		});
	});

	describe('SDK session ID capture', () => {
		it('should capture SDK session ID from system message', async () => {
			const updateSessionSpy = mockDb.updateSession as ReturnType<typeof mock>;
			const sdkSessionId = generateUUID();

			const systemMessage: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: sdkSessionId,
				apiKeySource: 'env',
				claude_code_version: '0.1.0',
				cwd: '/test/workspace',
				tools: [],
				mcp_servers: [],
				model: 'claude-sonnet-4-5-20250929',
				permissionMode: 'bypassPermissions',
				slash_commands: [],
				output_style: 'concise',
				skills: [],
				plugins: [],
			};

			await handler.handleMessage(systemMessage);

			// Should update session with SDK session ID
			expect(updateSessionSpy).toHaveBeenCalledWith(testSessionId, {
				sdkSessionId,
			});
		});

		it('should emit session:updated event when capturing SDK session ID', async () => {
			const sdkSessionId = generateUUID();

			const systemMessage: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: sdkSessionId,
				apiKeySource: 'env',
				claude_code_version: '0.1.0',
				cwd: '/test/workspace',
				tools: [],
				mcp_servers: [],
				model: 'claude-sonnet-4-5-20250929',
				permissionMode: 'bypassPermissions',
				slash_commands: [],
				output_style: 'concise',
				skills: [],
				plugins: [],
			};

			await handler.handleMessage(systemMessage);

			// Event includes session data for event-sourced architecture
			expect(eventBusEmitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'sdk-session',
				session: { sdkSessionId },
			});
		});

		it('should not capture SDK session ID if already set', async () => {
			const updateSessionSpy = mockDb.updateSession as ReturnType<typeof mock>;
			updateSessionSpy.mockClear();

			// Session already has SDK session ID
			mockSession.sdkSessionId = 'existing-sdk-session-id';

			const systemMessage: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: 'new-sdk-session-id',
				apiKeySource: 'env',
				claude_code_version: '0.1.0',
				cwd: '/test/workspace',
				tools: [],
				mcp_servers: [],
				model: 'claude-sonnet-4-5-20250929',
				permissionMode: 'bypassPermissions',
				slash_commands: [],
				output_style: 'concise',
				skills: [],
				plugins: [],
			};

			await handler.handleMessage(systemMessage);

			// Should still save message and broadcast, but not update SDK session ID
			expect(dbSaveSpy).toHaveBeenCalled();
			// updateSession may be called by other handlers, but not for sdkSessionId
			const sdkSessionIdUpdates = updateSessionSpy.mock.calls.filter((call: unknown[]) => {
				const updates = call[1] as { sdkSessionId?: string };
				return updates && 'sdkSessionId' in updates;
			});
			expect(sdkSessionIdUpdates.length).toBe(0);
		});

		it('should update in-memory session with SDK session ID', async () => {
			const sdkSessionId = generateUUID();

			const systemMessage: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: generateUUID() as `${string}-${string}-${string}-${string}-${string}`,
				session_id: sdkSessionId,
				apiKeySource: 'env',
				claude_code_version: '0.1.0',
				cwd: '/test/workspace',
				tools: [],
				mcp_servers: [],
				model: 'claude-sonnet-4-5-20250929',
				permissionMode: 'bypassPermissions',
				slash_commands: [],
				output_style: 'concise',
				skills: [],
				plugins: [],
			};

			await handler.handleMessage(systemMessage);

			// Verify in-memory session was updated
			expect(mockSession.sdkSessionId).toBe(sdkSessionId);
		});
	});
});
