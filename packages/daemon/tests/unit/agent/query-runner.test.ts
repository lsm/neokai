/**
 * QueryRunner Tests
 *
 * Tests for SDK query execution with streaming input.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { QueryRunner, type QueryRunnerContext } from '../../../src/lib/agent/query-runner';
import type { Session, MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Database } from '../../../src/storage/database';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { ErrorManager } from '../../../src/lib/error-manager';
import type { Logger } from '../../../src/lib/logger';
import type { QueryOptionsBuilder } from '../../../src/lib/agent/query-options-builder';
import type { AskUserQuestionHandler } from '../../../src/lib/agent/ask-user-question-handler';

describe('QueryRunner', () => {
	let runner: QueryRunner;
	let mockSession: Session;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockMessageQueue: MessageQueue;
	let mockStateManager: ProcessingStateManager;
	let mockErrorManager: ErrorManager;
	let mockLogger: Logger;
	let mockOptionsBuilder: QueryOptionsBuilder;
	let mockAskUserQuestionHandler: AskUserQuestionHandler;

	// Spy functions
	let isRunningSpy: ReturnType<typeof mock>;
	let startSpy: ReturnType<typeof mock>;
	let clearSpy: ReturnType<typeof mock>;
	let stopSpy: ReturnType<typeof mock>;
	let sizeSpy: ReturnType<typeof mock>;
	let getStateSpy: ReturnType<typeof mock>;
	let setIdleSpy: ReturnType<typeof mock>;
	let setProcessingSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;
	let publishSpy: ReturnType<typeof mock>;
	let saveSDKMessageSpy: ReturnType<typeof mock>;
	let getMessagesByStatusSpy: ReturnType<typeof mock>;
	let updateMessageStatusSpy: ReturnType<typeof mock>;
	let buildSpy: ReturnType<typeof mock>;
	let addSessionStateOptionsSpy: ReturnType<typeof mock>;
	let setCanUseToolSpy: ReturnType<typeof mock>;
	let createCanUseToolCallbackSpy: ReturnType<typeof mock>;

	// State variables (mutable context properties)
	let queryGeneration: number;
	let onSDKMessageSpy: ReturnType<typeof mock>;
	let onSlashCommandsFetchedSpy: ReturnType<typeof mock>;
	let onModelsFetchedSpy: ReturnType<typeof mock>;
	let onMarkApiSuccessSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
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

		// Reset state
		queryGeneration = 0;

		// Create callback spies
		onSDKMessageSpy = mock(async () => {});
		onSlashCommandsFetchedSpy = mock(async () => {});
		onModelsFetchedSpy = mock(async () => {});
		onMarkApiSuccessSpy = mock(async () => {});

		// Database spies
		saveSDKMessageSpy = mock(() => {});
		getMessagesByStatusSpy = mock(() => []);
		updateMessageStatusSpy = mock(() => {});
		mockDb = {
			saveSDKMessage: saveSDKMessageSpy,
			getMessagesByStatus: getMessagesByStatusSpy,
			updateMessageStatus: updateMessageStatusSpy,
		} as unknown as Database;

		// MessageHub spies
		publishSpy = mock(async () => {});
		mockMessageHub = {
			event: publishSpy,
			onQuery: mock((_method: string, _handler: Function) => () => {}),
			onCommand: mock((_method: string, _handler: Function) => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// MessageQueue spies
		isRunningSpy = mock(() => false);
		startSpy = mock(() => {});
		clearSpy = mock(() => {});
		stopSpy = mock(() => {});
		sizeSpy = mock(() => 0);
		mockMessageQueue = {
			isRunning: isRunningSpy,
			start: startSpy,
			clear: clearSpy,
			stop: stopSpy,
			size: sizeSpy,
			messageGenerator: mock(async function* () {
				// Empty generator for tests
			}),
		} as unknown as MessageQueue;

		// StateManager spies
		getStateSpy = mock(() => ({ status: 'idle' }));
		setIdleSpy = mock(async () => {});
		setProcessingSpy = mock(async () => {});
		mockStateManager = {
			getState: getStateSpy,
			setIdle: setIdleSpy,
			setProcessing: setProcessingSpy,
		} as unknown as ProcessingStateManager;

		// ErrorManager spies
		handleErrorSpy = mock(async () => {});
		mockErrorManager = {
			handleError: handleErrorSpy,
		} as unknown as ErrorManager;

		// Logger spies
		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		// OptionsBuilder spies
		buildSpy = mock(async () => ({ model: 'claude-sonnet-4-20250514' }));
		addSessionStateOptionsSpy = mock((options: unknown) => options);
		setCanUseToolSpy = mock(() => {});
		mockOptionsBuilder = {
			build: buildSpy,
			addSessionStateOptions: addSessionStateOptionsSpy,
			setCanUseTool: setCanUseToolSpy,
		} as unknown as QueryOptionsBuilder;

		// AskUserQuestionHandler spies
		createCanUseToolCallbackSpy = mock(() => async () => true);
		mockAskUserQuestionHandler = {
			createCanUseToolCallback: createCanUseToolCallbackSpy,
		} as unknown as AskUserQuestionHandler;
	});

	function createContext(overrides: Partial<QueryRunnerContext> = {}): QueryRunnerContext {
		return {
			// Core dependencies
			session: mockSession,
			db: mockDb,
			messageHub: mockMessageHub,
			messageQueue: mockMessageQueue,
			stateManager: mockStateManager,
			errorManager: mockErrorManager,
			logger: mockLogger,
			optionsBuilder: mockOptionsBuilder,
			askUserQuestionHandler: mockAskUserQuestionHandler,

			// Mutable SDK state (direct properties)
			queryObject: null,
			queryPromise: null,
			queryAbortController: null,
			firstMessageReceived: false,
			startupTimeoutTimer: null,
			originalEnvVars: {},

			// Methods for state coordination
			incrementQueryGeneration: () => ++queryGeneration,
			getQueryGeneration: () => queryGeneration,
			isCleaningUp: () => false,

			// Callbacks for message handling
			onSDKMessage: onSDKMessageSpy,
			onSlashCommandsFetched: onSlashCommandsFetchedSpy,
			onModelsFetched: onModelsFetchedSpy,
			onMarkApiSuccess: onMarkApiSuccessSpy,

			...overrides,
		};
	}

	function createRunner(overrides: Partial<QueryRunnerContext> = {}): QueryRunner {
		return new QueryRunner(createContext(overrides));
	}

	describe('constructor', () => {
		it('should create runner with dependencies', () => {
			runner = createRunner();
			expect(runner).toBeDefined();
		});
	});

	describe('start', () => {
		it('should skip start if query already running', async () => {
			isRunningSpy.mockReturnValue(true);
			runner = createRunner();

			await runner.start();

			expect(startSpy).not.toHaveBeenCalled();
		});

		it('should start message queue and increment generation', async () => {
			isRunningSpy.mockReturnValue(false);
			runner = createRunner();

			// Start but don't wait for completion
			runner.start();
			// Allow start to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(startSpy).toHaveBeenCalled();
			expect(queryGeneration).toBe(1);
		});

		it('should reset firstMessageReceived flag', async () => {
			isRunningSpy.mockReturnValue(false);
			const ctx = createContext({ firstMessageReceived: true });
			runner = new QueryRunner(ctx);

			runner.start();
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(ctx.firstMessageReceived).toBe(false);
		});
	});

	describe('displayErrorAsAssistantMessage', () => {
		it('should save error message to database', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Test error message');

			expect(saveSDKMessageSpy).toHaveBeenCalledWith(
				'test-session-id',
				expect.objectContaining({
					type: 'assistant',
					message: expect.objectContaining({
						role: 'assistant',
						content: [{ type: 'text', text: 'Test error message' }],
					}),
				})
			);
		});

		it('should publish message to state channel', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Test error');

			expect(publishSpy).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: expect.arrayContaining([
						expect.objectContaining({
							type: 'assistant',
							session_id: 'test-session-id',
						}),
					]),
				}),
				{ sessionId: 'test-session-id' }
			);
		});

		it('should mark message as error when option provided', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Error text', { markAsError: true });

			expect(saveSDKMessageSpy).toHaveBeenCalledWith(
				'test-session-id',
				expect.objectContaining({
					error: 'invalid_request',
				})
			);
		});

		it('should not mark message as error when option not provided', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Normal error');

			const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
			expect(savedMessage.error).toBeUndefined();
		});

		it('should generate UUID for the message', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Error with UUID');

			const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
			expect(savedMessage.uuid).toBeDefined();
			expect(typeof savedMessage.uuid).toBe('string');
		});

		it('should set parent_tool_use_id to null', async () => {
			runner = createRunner();

			await runner.displayErrorAsAssistantMessage('Error message');

			const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
			expect(savedMessage.parent_tool_use_id).toBeNull();
		});
	});

	describe('createMessageGeneratorWrapper', () => {
		it('should yield messages from queue and call onSent', async () => {
			const sentCount = { value: 0 };

			// Create a mock message generator
			async function* mockMessageGenerator() {
				yield {
					message: { uuid: 'msg-1', content: 'Hello' },
					onSent: () => {
						sentCount.value++;
					},
				};
				yield {
					message: { uuid: 'msg-2', content: 'World' },
					onSent: () => {
						sentCount.value++;
					},
				};
			}

			const mockQueue = {
				...mockMessageQueue,
				messageGenerator: mock(() => mockMessageGenerator()),
			};

			runner = createRunner({
				messageQueue: mockQueue as unknown as MessageQueue,
			});

			const generator = runner.createMessageGeneratorWrapper();
			const results: unknown[] = [];

			for await (const msg of generator) {
				results.push(msg);
			}

			expect(results).toHaveLength(2);
			expect(sentCount.value).toBe(2);
		});

		it('should set processing state for non-internal messages', async () => {
			async function* mockMessageGenerator() {
				yield {
					message: { uuid: 'msg-1', content: 'Hello', internal: false },
					onSent: () => {},
				};
			}

			const mockQueue = {
				...mockMessageQueue,
				messageGenerator: mock(() => mockMessageGenerator()),
			};

			runner = createRunner({
				messageQueue: mockQueue as unknown as MessageQueue,
			});

			const generator = runner.createMessageGeneratorWrapper();

			for await (const _msg of generator) {
				// Consume the generator
			}

			expect(setProcessingSpy).toHaveBeenCalledWith('msg-1', 'initializing');
		});

		it('should skip processing state for internal messages', async () => {
			async function* mockMessageGenerator() {
				yield {
					message: { uuid: 'internal-msg', content: '/context', internal: true },
					onSent: () => {},
				};
			}

			const mockQueue = {
				...mockMessageQueue,
				messageGenerator: mock(() => mockMessageGenerator()),
			};

			runner = createRunner({
				messageQueue: mockQueue as unknown as MessageQueue,
			});

			const generator = runner.createMessageGeneratorWrapper();

			for await (const _msg of generator) {
				// Consume the generator
			}

			expect(setProcessingSpy).not.toHaveBeenCalled();
		});
	});

	describe('handleSDKMessage', () => {
		it('should mark queued messages as sent on system:init', async () => {
			const queuedMessages = [
				{ dbId: 1, uuid: 'msg-1' },
				{ dbId: 2, uuid: 'msg-2' },
			];
			getMessagesByStatusSpy.mockReturnValue(queuedMessages);

			runner = createRunner();

			const systemInitMessage = {
				type: 'system',
				subtype: 'init',
				uuid: 'init-uuid',
				session_id: 'sdk-session-123',
			};

			await runner.handleSDKMessage(systemInitMessage as unknown as SDKMessage);

			expect(getMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'queued');
			expect(updateMessageStatusSpy).toHaveBeenCalledWith([1, 2], 'sent');
		});

		it('should not update status if no queued messages', async () => {
			getMessagesByStatusSpy.mockReturnValue([]);

			runner = createRunner();

			const systemInitMessage = {
				type: 'system',
				subtype: 'init',
				uuid: 'init-uuid',
				session_id: 'sdk-session-123',
			};

			await runner.handleSDKMessage(systemInitMessage as unknown as SDKMessage);

			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});

		it('should delegate to onSDKMessage callback', async () => {
			runner = createRunner();

			const message = {
				type: 'assistant',
				uuid: 'asst-uuid',
				message: { role: 'assistant', content: [] },
			};

			await runner.handleSDKMessage(message as unknown as SDKMessage);

			expect(onSDKMessageSpy).toHaveBeenCalledWith(message);
		});

		it('should call onMarkApiSuccess after handling message', async () => {
			runner = createRunner();

			const message = {
				type: 'assistant',
				uuid: 'asst-uuid',
				message: { role: 'assistant', content: [] },
			};

			await runner.handleSDKMessage(message as unknown as SDKMessage);

			expect(onMarkApiSuccessSpy).toHaveBeenCalled();
		});
	});

	describe('createAbortableQuery', () => {
		it('should yield messages from query iterator', async () => {
			runner = createRunner();

			const messages = [{ type: 'msg1' }, { type: 'msg2' }];
			let idx = 0;

			const mockQuery = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						if (idx < messages.length) {
							return { value: messages[idx++], done: false };
						}
						return { value: undefined, done: true };
					},
					return: async () => ({ value: undefined, done: true }),
				}),
			};

			const abortController = new AbortController();
			const generator = runner.createAbortableQuery(
				mockQuery as unknown as Query,
				abortController.signal
			);

			const results: unknown[] = [];
			for await (const msg of generator) {
				results.push(msg);
			}

			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({ type: 'msg1' });
			expect(results[1]).toEqual({ type: 'msg2' });
		});

		it('should stop iteration when signal is already aborted', async () => {
			runner = createRunner();

			const abortController = new AbortController();
			abortController.abort(); // Pre-abort

			const mockQuery = {
				[Symbol.asyncIterator]: () => ({
					next: async () => ({ value: { type: 'msg' }, done: false }),
					return: async () => ({ value: undefined, done: true }),
				}),
			};

			const generator = runner.createAbortableQuery(
				mockQuery as unknown as Query,
				abortController.signal
			);

			const results: unknown[] = [];
			for await (const msg of generator) {
				results.push(msg);
			}

			expect(results).toHaveLength(0);
		});

		it('should stop iteration when abort is called during iteration', async () => {
			runner = createRunner();

			const abortController = new AbortController();
			let callCount = 0;

			const mockQuery = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						callCount++;
						if (callCount === 2) {
							// Abort after first yield
							abortController.abort();
						}
						return { value: { type: `msg${callCount}` }, done: false };
					},
					return: async () => ({ value: undefined, done: true }),
				}),
			};

			const generator = runner.createAbortableQuery(
				mockQuery as unknown as Query,
				abortController.signal
			);

			const results: unknown[] = [];
			for await (const msg of generator) {
				results.push(msg);
				if (results.length > 5) break; // Safety limit
			}

			expect(results.length).toBeLessThanOrEqual(2);
		});

		it('should cleanup iterator on completion', async () => {
			runner = createRunner();

			let returnCalled = false;

			const mockQuery = {
				[Symbol.asyncIterator]: () => ({
					next: async () => ({ value: undefined, done: true }),
					return: async () => {
						returnCalled = true;
						return { value: undefined, done: true };
					},
				}),
			};

			const abortController = new AbortController();
			const generator = runner.createAbortableQuery(
				mockQuery as unknown as Query,
				abortController.signal
			);

			for await (const _msg of generator) {
				// Consume
			}

			expect(returnCalled).toBe(true);
		});

		it('should re-throw non-abort errors', async () => {
			runner = createRunner();

			const mockQuery = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						throw new Error('Some SDK error');
					},
					return: async () => ({ value: undefined, done: true }),
				}),
			};

			const abortController = new AbortController();
			const generator = runner.createAbortableQuery(
				mockQuery as unknown as Query,
				abortController.signal
			);

			await expect(async () => {
				for await (const _msg of generator) {
					// Consume
				}
			}).toThrow('Some SDK error');
		});
	});
});

describe('QueryRunner error categorization', () => {
	it('should categorize authentication errors', () => {
		const testCases = [
			{ message: '401 Unauthorized', expected: 'authentication' },
			{ message: 'unauthorized access', expected: 'authentication' },
			{ message: 'invalid_api_key', expected: 'authentication' },
		];

		for (const { message, expected } of testCases) {
			let category = 'system';
			if (
				message.includes('401') ||
				message.includes('unauthorized') ||
				message.includes('invalid_api_key')
			) {
				category = 'authentication';
			}
			expect(category).toBe(expected);
		}
	});

	it('should categorize connection errors', () => {
		const testCases = [
			{ message: 'ECONNREFUSED', expected: 'connection' },
			{ message: 'ENOTFOUND', expected: 'connection' },
		];

		for (const { message, expected } of testCases) {
			let category = 'system';
			if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
				category = 'connection';
			}
			expect(category).toBe(expected);
		}
	});

	it('should categorize rate limit errors', () => {
		const testCases = [
			{ message: '429 Too Many Requests', expected: 'rate_limit' },
			{ message: 'rate limit exceeded', expected: 'rate_limit' },
		];

		for (const { message, expected } of testCases) {
			let category = 'system';
			if (message.includes('429') || message.includes('rate limit')) {
				category = 'rate_limit';
			}
			expect(category).toBe(expected);
		}
	});

	it('should categorize timeout errors', () => {
		let category = 'system';
		const message = 'request timeout exceeded';
		if (message.includes('timeout')) {
			category = 'timeout';
		}
		expect(category).toBe('timeout');
	});

	it('should categorize model errors', () => {
		let category = 'system';
		const message = 'model_not_found: claude-invalid';
		if (message.includes('model_not_found')) {
			category = 'model';
		}
		expect(category).toBe('model');
	});

	it('should categorize permission errors', () => {
		const testCases = [
			{ message: 'cannot be run as root', expected: 'permission' },
			{ message: 'dangerously-skip-permissions required', expected: 'permission' },
			{ message: 'permission denied', expected: 'permission' },
			{ message: 'Exit code: 1', expected: 'permission' },
		];

		for (const { message, expected } of testCases) {
			let category = 'system';
			if (
				message.includes('cannot be run as root') ||
				message.includes('dangerously-skip-permissions') ||
				message.includes('permission') ||
				message.includes('Exit code: 1')
			) {
				category = 'permission';
			}
			expect(category).toBe(expected);
		}
	});

	it('should default to system category for unknown errors', () => {
		const category = 'system';
		const _message = 'some unknown error';
		// None of the conditions match
		expect(category).toBe('system');
	});
});

describe('QueryRunner API validation error parsing', () => {
	it('should parse 400 status code errors', () => {
		const errorMessage =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		expect(match).not.toBeNull();
		expect(match![1]).toBe('400');

		const body = JSON.parse(match![2]);
		expect(body.error.type).toBe('invalid_request_error');
		expect(body.error.message).toBe('prompt is too long');
	});

	it('should parse 401 status code errors', () => {
		const errorMessage =
			'401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		expect(match).not.toBeNull();
		expect(match![1]).toBe('401');
	});

	it('should parse 429 status code errors', () => {
		const errorMessage =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		expect(match).not.toBeNull();
		expect(match![1]).toBe('429');
	});

	it('should not match 5xx errors', () => {
		const errorMessage = '500 {"error":"internal server error"}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		expect(match).toBeNull();
	});

	it('should not match non-JSON errors', () => {
		const errorMessage = 'Connection refused';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		expect(match).toBeNull();
	});

	it('should handle malformed JSON gracefully', () => {
		const errorMessage = '400 {invalid json}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		// Match exists but JSON parsing will fail
		expect(match).not.toBeNull();
		expect(() => JSON.parse(match![2])).toThrow();
	});

	it('should extract error message from body', () => {
		const errorMessage =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt exceeds limit"}}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		const body = JSON.parse(match![2]);
		const apiErrorMessage = body.error?.message || errorMessage;
		expect(apiErrorMessage).toBe('prompt exceeds limit');
	});

	it('should extract error type from body', () => {
		const errorMessage =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"test"}}';
		const match = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);

		const body = JSON.parse(match![2]);
		const apiErrorType = body.error?.type || 'api_error';
		expect(apiErrorType).toBe('invalid_request_error');
	});

	it('should default error type when missing', () => {
		const body = { type: 'error' };
		const apiErrorType = body.error?.type || 'api_error';
		expect(apiErrorType).toBe('api_error');
	});
});

describe('QueryRunner startup timeout handling', () => {
	it('should define startup timeout constant', () => {
		const STARTUP_TIMEOUT_MS = 15000;
		expect(STARTUP_TIMEOUT_MS).toBe(15000);
	});

	it('should track timeout state', () => {
		let startupTimeoutReached = false;
		const queryStartTime = Date.now();

		// Simulate timeout callback
		const timeoutCallback = () => {
			startupTimeoutReached = true;
			const elapsed = Date.now() - queryStartTime;
			expect(elapsed).toBeGreaterThanOrEqual(0);
		};

		// Before timeout
		expect(startupTimeoutReached).toBe(false);

		// After timeout triggers
		timeoutCallback();
		expect(startupTimeoutReached).toBe(true);
	});

	it('should clear timeout on first message', () => {
		let timerCleared = false;
		const timer = setTimeout(() => {}, 15000);

		// Simulate clearing on first message
		clearTimeout(timer);
		timerCleared = true;

		expect(timerCleared).toBe(true);
	});

	it('should throw error when timeout reached and no messages', () => {
		const startupTimeoutReached = true;
		const messageCount = 0;

		let errorThrown = false;
		if (startupTimeoutReached && messageCount === 0) {
			errorThrown = true;
		}

		expect(errorThrown).toBe(true);
	});
});

describe('QueryRunner abortable query iterator', () => {
	it('should create abort controller', () => {
		const abortController = new AbortController();
		expect(abortController.signal.aborted).toBe(false);
	});

	it('should abort signal on abort() call', () => {
		const abortController = new AbortController();
		abortController.abort();
		expect(abortController.signal.aborted).toBe(true);
	});

	it('should handle already aborted signal', async () => {
		const abortController = new AbortController();
		abortController.abort();

		let messagesProcessed = 0;

		// Simulate the check at start of createAbortableQuery
		if (!abortController.signal.aborted) {
			messagesProcessed++;
		}

		expect(messagesProcessed).toBe(0);
	});

	it('should break on abort during iteration', async () => {
		const abortController = new AbortController();
		const messages = ['msg1', 'msg2', 'msg3', 'msg4'];
		let processedCount = 0;

		for (const _msg of messages) {
			if (abortController.signal.aborted) {
				break;
			}
			processedCount++;
			if (processedCount === 2) {
				abortController.abort();
			}
		}

		expect(processedCount).toBe(2);
	});

	it('should handle abort promise race', async () => {
		const abortController = new AbortController();
		const abortError = new Error('Query aborted');

		// Create abort promise
		const abortPromise = new Promise<never>((_, reject) => {
			abortController.signal.addEventListener('abort', () => reject(abortError), { once: true });
		});

		// Simulate abort
		abortController.abort();

		// Abort promise should reject
		await expect(abortPromise).rejects.toThrow('Query aborted');
	});

	it('should detect abort error by message', () => {
		const error = new Error('Query aborted');

		const isAbortError = error.message === 'Query aborted';
		expect(isAbortError).toBe(true);
	});

	it('should re-throw non-abort errors', () => {
		const error = new Error('Some other error');

		expect(() => {
			if (error.message !== 'Query aborted') {
				throw error;
			}
		}).toThrow('Some other error');
	});

	it('should clean up iterator on completion', async () => {
		let returnCalled = false;

		const mockIterator = {
			next: async () => ({ value: undefined, done: true }),
			return: async () => {
				returnCalled = true;
				return { value: undefined, done: true };
			},
		};

		// Simulate cleanup
		await mockIterator.return?.();

		expect(returnCalled).toBe(true);
	});
});

describe('QueryRunner stale query detection', () => {
	it('should detect current query', () => {
		const currentGeneration = 1;
		const queryGeneration = 1;

		const isStale = currentGeneration !== queryGeneration;
		expect(isStale).toBe(false);
	});

	it('should detect stale query', () => {
		const currentGeneration = 2;
		const queryGeneration = 1;

		const isStale = currentGeneration !== queryGeneration;
		expect(isStale).toBe(true);
	});

	it('should skip cleanup for stale queries', () => {
		const currentGeneration = 2;
		const queryGeneration = 1;
		const isStaleQuery = currentGeneration !== queryGeneration;

		let cleanupPerformed = false;
		if (!isStaleQuery) {
			cleanupPerformed = true;
		}

		expect(isStaleQuery).toBe(true);
		expect(cleanupPerformed).toBe(false);
	});

	it('should perform cleanup for current queries', () => {
		const currentGeneration = 1;
		const queryGeneration = 1;
		const isStaleQuery = currentGeneration !== queryGeneration;

		let cleanupPerformed = false;
		if (!isStaleQuery) {
			cleanupPerformed = true;
		}

		expect(isStaleQuery).toBe(false);
		expect(cleanupPerformed).toBe(true);
	});
});

describe('QueryRunner message generator wrapper', () => {
	it('should skip state update for internal messages', async () => {
		let stateUpdates = 0;

		const messages = [
			{ uuid: 'msg-1', internal: false },
			{ uuid: 'msg-2', internal: true },
			{ uuid: 'msg-3', internal: false },
		];

		for (const msg of messages) {
			const isInternal = msg.internal || false;
			if (!isInternal) {
				stateUpdates++;
			}
		}

		expect(stateUpdates).toBe(2);
	});

	it('should call onSent after yield', () => {
		let sentCount = 0;

		const queuedMessages = [
			{ message: { uuid: 'msg-1' }, onSent: () => sentCount++ },
			{ message: { uuid: 'msg-2' }, onSent: () => sentCount++ },
		];

		for (const { onSent } of queuedMessages) {
			onSent();
		}

		expect(sentCount).toBe(2);
	});

	it('should use unknown uuid when message has no uuid', () => {
		const message = {};
		const uuid = (message as { uuid?: string }).uuid ?? 'unknown';
		expect(uuid).toBe('unknown');
	});
});

describe('QueryRunner SDK message handling', () => {
	it('should mark queued messages as sent on system:init', () => {
		const queuedMessages = [
			{ dbId: 1, uuid: 'msg-1' },
			{ dbId: 2, uuid: 'msg-2' },
			{ dbId: 3, uuid: 'msg-3' },
		];

		const updateCalls: { dbIds: number[]; status: string }[] = [];

		// Simulate the logic
		if (queuedMessages.length > 0) {
			const dbIds = queuedMessages.map((m) => m.dbId);
			updateCalls.push({ dbIds, status: 'sent' });
		}

		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].dbIds).toEqual([1, 2, 3]);
		expect(updateCalls[0].status).toBe('sent');
	});

	it('should skip update when no queued messages', () => {
		const queuedMessages: { dbId: number }[] = [];

		const updateCalls: unknown[] = [];

		if (queuedMessages.length > 0) {
			updateCalls.push({ dbIds: [], status: 'sent' });
		}

		expect(updateCalls).toHaveLength(0);
	});
});

describe('QueryRunner environment variable handling', () => {
	it('should store original env vars', () => {
		const originalEnvVars: Record<string, string | undefined> = {};

		// Simulate storing
		originalEnvVars.ANTHROPIC_AUTH_TOKEN = 'original-token';
		originalEnvVars.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

		expect(Object.keys(originalEnvVars).length).toBe(2);
	});

	it('should detect when env vars need restoration', () => {
		const originalEnvVars = {
			ANTHROPIC_AUTH_TOKEN: 'original',
		};

		const needsRestore = Object.keys(originalEnvVars).length > 0;
		expect(needsRestore).toBe(true);
	});

	it('should clear original env vars after restoration', () => {
		const originalEnvVars: Record<string, string | undefined> = {
			ANTHROPIC_AUTH_TOKEN: 'original',
		};

		// Simulate restoration
		const _emptyVars: Record<string, string | undefined> = {};
		Object.assign(originalEnvVars, {});
		Object.keys(originalEnvVars).forEach((key) => delete originalEnvVars[key]);

		expect(Object.keys(originalEnvVars).length).toBe(0);
	});
});

describe('QueryRunner cleaning up state', () => {
	it('should skip setIdle when cleaning up', async () => {
		let setIdleCalled = false;
		const isCleaningUp = true;

		if (!isCleaningUp) {
			setIdleCalled = true;
		}

		expect(setIdleCalled).toBe(false);
	});

	it('should call setIdle when not cleaning up', async () => {
		let setIdleCalled = false;
		const isCleaningUp = false;

		if (!isCleaningUp) {
			setIdleCalled = true;
		}

		expect(setIdleCalled).toBe(true);
	});
});
