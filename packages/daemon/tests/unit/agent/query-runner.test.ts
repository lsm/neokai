/**
 * QueryRunner Tests
 *
 * Tests for SDK query execution with streaming input.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { QueryRunner, type QueryRunnerDependencies } from '../../../src/lib/agent/query-runner';
import type { Session, MessageHub } from '@liuboer/shared';
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

	// State callbacks
	let queryGeneration: number;
	let firstMessageReceived: boolean;
	let _queryObject: unknown | null;
	let _queryPromise: Promise<void> | null;
	let queryAbortController: AbortController | null;
	let startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
	let originalEnvVars: Record<string, string | undefined>;
	let cleaningUp: boolean;

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
		firstMessageReceived = false;
		_queryObject = null;
		_queryPromise = null;
		queryAbortController = null;
		startupTimeoutTimer = null;
		originalEnvVars = {};
		cleaningUp = false;

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
			publish: publishSpy,
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

	function createRunner(overrides: Partial<QueryRunnerDependencies> = {}): QueryRunner {
		const deps: QueryRunnerDependencies = {
			session: mockSession,
			db: mockDb,
			messageHub: mockMessageHub,
			messageQueue: mockMessageQueue,
			stateManager: mockStateManager,
			errorManager: mockErrorManager,
			logger: mockLogger,
			optionsBuilder: mockOptionsBuilder,
			askUserQuestionHandler: mockAskUserQuestionHandler,
			getQueryGeneration: () => queryGeneration,
			incrementQueryGeneration: () => ++queryGeneration,
			getFirstMessageReceived: () => firstMessageReceived,
			setFirstMessageReceived: (value: boolean) => {
				firstMessageReceived = value;
			},
			setQueryObject: (q: unknown | null) => {
				_queryObject = q;
			},
			setQueryPromise: (p: Promise<void> | null) => {
				_queryPromise = p;
			},
			setQueryAbortController: (c: AbortController | null) => {
				queryAbortController = c;
			},
			getQueryAbortController: () => queryAbortController,
			setStartupTimeoutTimer: (t: ReturnType<typeof setTimeout> | null) => {
				startupTimeoutTimer = t;
			},
			getStartupTimeoutTimer: () => startupTimeoutTimer,
			setOriginalEnvVars: (vars: Record<string, string | undefined>) => {
				originalEnvVars = vars;
			},
			getOriginalEnvVars: () => originalEnvVars,
			isCleaningUp: () => cleaningUp,
			onSDKMessage: mock(async () => {}),
			onSlashCommandsFetched: mock(async () => {}),
			onModelsFetched: mock(async () => {}),
			onMarkApiSuccess: mock(async () => {}),
			...overrides,
		};
		return new QueryRunner(deps);
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
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('already running'));
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
			firstMessageReceived = true;
			isRunningSpy.mockReturnValue(false);
			runner = createRunner();

			runner.start();
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(firstMessageReceived).toBe(false);
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
});
