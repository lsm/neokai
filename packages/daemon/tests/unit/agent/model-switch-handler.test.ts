/**
 * ModelSwitchHandler Tests
 *
 * Tests model switching logic for AgentSession.
 * Note: Tests that require model validation are skipped since model-service
 * functions cannot be easily mocked in ESM modules.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
	ModelSwitchHandler,
	type ModelSwitchHandlerContext,
} from '../../../src/lib/agent/model-switch-handler';
import type { Session, ModelInfo } from '@liuboer/shared';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../src/lib/agent/query-lifecycle-manager';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { ErrorManager } from '../../../src/lib/error-manager';
import type { Logger } from '../../../src/lib/logger';
import { generateUUID } from '@liuboer/shared';
import { resetProviderFactory, initializeProviders } from '../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../src/lib/providers/registry';
import { setModelsCache, clearModelsCache } from '../../../src/lib/model-service';

// Test model data for the models cache
const TEST_MODELS: ModelInfo[] = [
	{
		id: 'default',
		name: 'Claude Sonnet 4.5',
		alias: 'sonnet',
		family: 'sonnet',
		provider: 'anthropic',
		contextWindow: 200000,
		description: 'Default Sonnet model',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'opus',
		name: 'Claude Opus 4.5',
		alias: 'opus',
		family: 'opus',
		provider: 'anthropic',
		contextWindow: 200000,
		description: 'Opus model',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'haiku',
		name: 'Claude Haiku 4.5',
		alias: 'haiku',
		family: 'haiku',
		provider: 'anthropic',
		contextWindow: 200000,
		description: 'Haiku model',
		releaseDate: '2025-01-01',
		available: true,
	},
];

describe('ModelSwitchHandler', () => {
	let handler: ModelSwitchHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockDaemonHub: DaemonHub;
	let mockContextTracker: ContextTracker;
	let mockStateManager: ProcessingStateManager;
	let mockErrorManager: ErrorManager;
	let mockLogger: Logger;
	let mockLifecycleManager: QueryLifecycleManager;

	let publishSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let setModelSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;
	let setModelTrackerSpy: ReturnType<typeof mock>;
	let restartSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		// Initialize providers for model validation
		resetProviderRegistry();
		resetProviderFactory();
		clearModelsCache();
		initializeProviders();

		// Pre-populate the models cache with test models
		// This allows model validation to work without requiring API calls
		const cache = new Map<string, ModelInfo[]>();
		cache.set('global', TEST_MODELS);
		setModelsCache(cache);

		const sessionId = generateUUID();

		mockSession = {
			id: sessionId,
			title: 'Test Session',
			workspacePath: '/test/workspace',
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

		// Create mocks
		publishSpy = mock(async () => {});
		emitSpy = mock(async () => {});
		updateSessionSpy = mock(() => {});
		setModelSpy = mock(async () => {});
		handleErrorSpy = mock(async () => {});
		setModelTrackerSpy = mock(() => {});
		restartSpy = mock(async () => {});

		mockDb = {
			updateSession: updateSessionSpy,
		} as unknown as Database;

		mockMessageHub = {
			publish: publishSpy,
		} as unknown as MessageHub;

		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		mockContextTracker = {
			setModel: setModelTrackerSpy,
		} as unknown as ContextTracker;

		mockStateManager = {
			getState: mock(() => ({ status: 'idle' })),
		} as unknown as ProcessingStateManager;

		mockErrorManager = {
			handleError: handleErrorSpy,
		} as unknown as ErrorManager;

		mockLogger = {
			log: mock(() => {}),
			error: mock(() => {}),
		} as unknown as Logger;

		mockLifecycleManager = {
			restart: restartSpy,
		} as unknown as QueryLifecycleManager;
	});

	function createContext(
		overrides: Partial<ModelSwitchHandlerContext> = {}
	): ModelSwitchHandlerContext {
		return {
			session: mockSession,
			db: mockDb,
			messageHub: mockMessageHub,
			daemonHub: mockDaemonHub,
			contextTracker: mockContextTracker,
			stateManager: mockStateManager,
			errorManager: mockErrorManager,
			logger: mockLogger,
			lifecycleManager: mockLifecycleManager,
			queryObject: { setModel: setModelSpy } as unknown as Query,
			firstMessageReceived: true,
			...overrides,
		};
	}

	function createHandler(overrides: Partial<ModelSwitchHandlerContext> = {}): ModelSwitchHandler {
		return new ModelSwitchHandler(createContext(overrides));
	}

	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
		clearModelsCache();
	});

	describe('getCurrentModel', () => {
		it('should return current model info', () => {
			handler = createHandler();
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe('default');
			expect(modelInfo.info).toBeNull(); // Info is fetched async
		});

		it('should reflect session config model', () => {
			mockSession.config.model = 'opus';
			handler = createHandler();
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe('opus');
		});

		it('should return info as null (fetched asynchronously)', () => {
			handler = createHandler();
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo).toEqual({
				id: 'default',
				info: null,
			});
		});

		it('should track model changes in session config', () => {
			handler = createHandler();
			expect(handler.getCurrentModel().id).toBe('default');

			mockSession.config.model = 'haiku';
			expect(handler.getCurrentModel().id).toBe('haiku');

			mockSession.config.model = 'opus';
			expect(handler.getCurrentModel().id).toBe('opus');
		});
	});

	describe('constructor', () => {
		it('should accept all required dependencies', () => {
			const newHandler = createHandler();
			expect(newHandler).toBeDefined();
			expect(newHandler.getCurrentModel).toBeDefined();
			expect(newHandler.switchModel).toBeDefined();
		});
	});

	describe('context usage', () => {
		it('should use session from context', () => {
			handler = createHandler();
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe(mockSession.config.model);
		});
	});

	describe('switchModel', () => {
		// Use a valid model that's different from 'default'
		// 'opus' is a distinct model that will trigger actual switching
		const VALID_MODEL = 'opus';

		describe('when query not started', () => {
			it('should update config only when query not started', async () => {
				handler = createHandler({ queryObject: null });
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(updateSessionSpy).toHaveBeenCalled();
				expect(setModelTrackerSpy).toHaveBeenCalled();
				expect(restartSpy).not.toHaveBeenCalled();
			});

			it('should emit session.updated event', async () => {
				handler = createHandler({ queryObject: null });
				await handler.switchModel(VALID_MODEL);

				expect(emitSpy).toHaveBeenCalledWith(
					'session.updated',
					expect.objectContaining({
						sessionId: mockSession.id,
						source: 'model-switch',
					})
				);
			});

			it('should emit model-switching event', async () => {
				handler = createHandler({ queryObject: null });
				await handler.switchModel(VALID_MODEL);

				expect(publishSpy).toHaveBeenCalledWith(
					'session.model-switching',
					expect.objectContaining({
						from: 'default',
					}),
					{ sessionId: mockSession.id }
				);
			});

			it('should emit model-switched event on success', async () => {
				handler = createHandler({ queryObject: null });
				await handler.switchModel(VALID_MODEL);

				expect(publishSpy).toHaveBeenCalledWith(
					'session.model-switched',
					expect.objectContaining({
						from: 'default',
					}),
					{ sessionId: mockSession.id }
				);
			});
		});

		describe('when transport not ready', () => {
			it('should update config only when transport not ready', async () => {
				handler = createHandler({ firstMessageReceived: false });
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(updateSessionSpy).toHaveBeenCalled();
				expect(restartSpy).not.toHaveBeenCalled();
			});
		});

		describe('when query is running', () => {
			it('should restart query when running', async () => {
				handler = createHandler();
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(restartSpy).toHaveBeenCalled();
			});

			it('should update session config before restart', async () => {
				handler = createHandler();
				await handler.switchModel(VALID_MODEL);

				expect(updateSessionSpy).toHaveBeenCalled();
			});
		});

		describe('validation', () => {
			it('should reject invalid model', async () => {
				handler = createHandler();
				const result = await handler.switchModel('invalid-model-12345');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid model');
				expect(result.model).toBe('default'); // Returns current model
			});

			it('should return success with message when already using model', async () => {
				// No query running for simpler test
				handler = createHandler({ queryObject: null });
				// Switch to haiku first
				await handler.switchModel('haiku');
				// Then try to switch to haiku again
				const result = await handler.switchModel('haiku');

				expect(result.success).toBe(true);
				expect(result.error).toContain('Already using');
			});
		});

		describe('error handling', () => {
			it('should handle errors and call error manager', async () => {
				// Make restart throw
				restartSpy.mockRejectedValue(new Error('Restart failed'));
				handler = createHandler();

				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Restart failed');
				expect(handleErrorSpy).toHaveBeenCalled();
			});
		});

		describe('context tracker update', () => {
			it('should update context tracker model', async () => {
				// Set query to null so we don't need restart
				handler = createHandler({ queryObject: null });
				// Use haiku to ensure we're switching to a different model
				await handler.switchModel('haiku');

				expect(setModelTrackerSpy).toHaveBeenCalled();
			});
		});
	});
});
