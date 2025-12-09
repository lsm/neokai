/**
 * AgentSession Tests with Mocked SDK
 *
 * WHY WE USE A MOCK HERE:
 * -----------------------
 * These tests focus on AgentSession's message queuing, state management, and
 * WebSocket communication logic - NOT the actual Claude API integration.
 *
 * Using a mock allows us to:
 * 1. Test without requiring API credentials (enables testing in CI/CD)
 * 2. Test edge cases (abort, interrupts) without API rate limits
 * 3. Run tests quickly without network calls
 * 4. Focus on AgentSession behavior, not SDK behavior
 *
 * IMPORTANT: Real SDK integration is tested in daemon-style-sdk.test.ts
 * which uses actual credentials and makes real API calls.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import type { TestContext } from './test-utils';
import {
	createTestApp,
	createWebSocketWithFirstMessage,
	waitForWebSocketState,
	waitForWebSocketMessage,
} from './test-utils';

/**
 * Mock the Claude Agent SDK to avoid requiring API credentials.
 *
 * CRITICAL: Bun's mock.module() is GLOBAL across all test files in a test run.
 * We MUST call mock.restore() in afterAll() to prevent leaking this mock to
 * other test files (especially daemon-style-sdk.test.ts which needs the real SDK).
 */
beforeAll(async () => {
	mock.module('@anthropic-ai/claude-agent-sdk', () => {
		return {
			query: mock(
				(options: {
					prompt: AsyncGenerator<unknown> | string;
					options?: {
						model?: string;
						cwd?: string;
						abortController?: AbortController;
						permissionMode?: string;
						allowDangerouslySkipPermissions?: boolean;
						maxTurns?: number;
					};
				}) => {
					// Return a mock async iterable that processes input messages
					const mockQuery = {
						inputGenerator: typeof options.prompt !== 'string' ? options.prompt : null,
						messages: [] as unknown[],
						aborted: false,
						slashCommands: ['/help', '/clear', '/model'],

						getSlashCommands() {
							return this.slashCommands;
						},

						abort() {
							this.aborted = true;
						},

						async *[Symbol.asyncIterator]() {
							// Listen for abort
							if (options.options?.abortController) {
								options.options.abortController.signal.addEventListener('abort', () => {
									this.aborted = true;
								});
							}

							// Process input messages from generator
							if (this.inputGenerator) {
								while (!this.aborted) {
									try {
										const result = await Promise.race([
											this.inputGenerator.next(),
											new Promise<{ done: true; value: undefined }>((resolve) =>
												setTimeout(() => resolve({ done: true, value: undefined }), 100)
											),
										]);

										if (result.done || this.aborted) {
											break;
										}

										const userMessage = result.value as {
											type: string;
											uuid: string;
											session_id: string;
											message: { content: string | unknown[] };
										};

										// Yield a mock assistant response
										yield {
											type: 'assistant',
											uuid: crypto.randomUUID(),
											session_id: userMessage.session_id,
											message: {
												role: 'assistant',
												content: [
													{
														type: 'text',
														text: `Mock response to: ${
															typeof userMessage.message.content === 'string'
																? userMessage.message.content
																: '[complex content]'
														}`,
													},
												],
												model: options.options?.model || 'claude-sonnet-4-20250514',
												stop_reason: 'end_turn',
												stop_sequence: null,
												usage: {
													input_tokens: 100,
													output_tokens: 50,
													cache_creation_input_tokens: 0,
													cache_read_input_tokens: 0,
												},
											},
										};

										// Yield a mock result
										yield {
											type: 'result',
											uuid: crypto.randomUUID(),
											session_id: userMessage.session_id,
											is_error: false,
											num_turns: 1,
											subagent_results: [],
										};
									} catch {
										// Generator closed or error
										break;
									}
								}
							}
						},
					};

					return mockQuery;
				}
			),
		};
	});
});

describe('AgentSession with Mocked SDK', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('handleMessageSend', () => {
		test('should handle message send and receive mocked response', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(), // Use actual directory to avoid EROFS
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send a message
			const result = await agentSession!.handleMessageSend({
				content: 'Hello, Claude!',
			});

			expect(result.messageId).toBeString();
			expect(result.messageId.length).toBeGreaterThan(0);

			// State should transition to queued or processing
			const state = agentSession!.getProcessingState();
			expect(['queued', 'processing', 'idle']).toContain(state.status);
		});

		test('should handle message with images', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			const result = await agentSession!.handleMessageSend({
				content: 'What is in this image?',
				images: [
					{
						media_type: 'image/png',
						// 1x1 transparent PNG
						data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
					},
				],
			});

			expect(result.messageId).toBeString();
		});
	});

	describe('enqueueMessage', () => {
		test('should enqueue message and resolve with messageId', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// First trigger the query to start via handleMessageSend
			await agentSession!.handleMessageSend({ content: 'Start query' });

			// Now enqueue another message
			const messageIdPromise = agentSession!.enqueueMessage('Test message');

			// The promise should resolve with a message ID
			const messageId = await Promise.race([
				messageIdPromise,
				new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
			]);

			expect(messageId).toBeString();
			expect(messageId.length).toBeGreaterThan(0);
		});
	});

	describe('sendMessage (deprecated)', () => {
		test('should delegate to enqueueMessage', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// First trigger the query to start via handleMessageSend
			await agentSession!.handleMessageSend({ content: 'Start query' });

			// Use deprecated sendMessage method
			const messageIdPromise = agentSession!.sendMessage('Test message via deprecated method');

			// The promise should resolve with a message ID
			const messageId = await Promise.race([
				messageIdPromise,
				new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
			]);

			expect(messageId).toBeString();
			expect(messageId.length).toBeGreaterThan(0);
		});
	});

	describe('getSlashCommands', () => {
		test('should return slash commands from mocked SDK', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Start the query first
			await agentSession!.handleMessageSend({ content: 'Start' });

			// Give it a moment to start
			await Bun.sleep(100);

			const commands = await agentSession!.getSlashCommands();

			// Should return mock slash commands
			expect(commands).toBeArray();
		});
	});

	describe('handleInterrupt', () => {
		test('should interrupt and reset state', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Start processing
			await agentSession!.handleMessageSend({ content: 'Hello' });

			// Interrupt
			await agentSession!.handleInterrupt();

			// State should be idle
			const state = agentSession!.getProcessingState();
			expect(state.status).toBe('idle');
		});
	});

	describe('WebSocket message.send with mocked SDK', () => {
		test('should accept message and return result via WebSocket', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'msg-mock-1',
					type: 'CALL',
					method: 'message.send',
					data: {
						sessionId,
						content: 'Hello from WebSocket!',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.messageId).toBeString();

			ws.close();
		});
	});

	describe('SDK message broadcasting', () => {
		test('should broadcast sdk.message events when processing', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to sdk.message events
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-sdk-1',
					type: 'SUBSCRIBE',
					method: 'sdk.message',
					sessionId,
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Start processing a message
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			await agentSession!.handleMessageSend({ content: 'Trigger SDK message' });

			// Wait for SDK message event
			const sdkEvent = await waitForWebSocketMessage(ws, 5000);

			// Should receive an sdk.message event (assistant or result type)
			expect(sdkEvent.type).toBe('EVENT');
			expect(sdkEvent.method).toBe('sdk.message');

			ws.close();
		});
	});
});

describe('AgentSession state transitions with Mocked SDK', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('should transition through processing states', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

		// Initial state should be idle
		expect(agentSession!.getProcessingState().status).toBe('idle');

		// Send message
		await agentSession!.handleMessageSend({ content: 'Test' });

		// State should be queued or processing
		const stateAfterSend = agentSession!.getProcessingState();
		expect(['queued', 'processing', 'idle']).toContain(stateAfterSend.status);
	});

	test('should handle multiple messages in sequence', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

		// Send multiple messages
		const promises = [
			agentSession!.handleMessageSend({ content: 'Message 1' }),
			agentSession!.handleMessageSend({ content: 'Message 2' }),
		];

		const results = await Promise.all(promises);

		// All should have unique message IDs
		expect(results[0].messageId).toBeString();
		expect(results[1].messageId).toBeString();
		expect(results[0].messageId).not.toBe(results[1].messageId);
	});
});

/**
 * CRITICAL CLEANUP: Restore the real Claude Agent SDK module.
 *
 * Without this, the mock leaks to subsequent test files because Bun's
 * mock.module() is global. This caused daemon-style-sdk.test.ts to fail
 * because it received the mocked SDK instead of the real one.
 *
 * See commit: "fix(test): restore SDK mock after agent-session-mocked tests"
 */
afterAll(() => {
	mock.restore();
});
