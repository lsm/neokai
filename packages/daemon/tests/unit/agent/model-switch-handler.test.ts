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
	type ModelSwitchDependencies,
} from '../../../src/lib/agent/model-switch-handler';
import type { Session, ModelInfo } from '@liuboer/shared';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
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
	let mockDeps: ModelSwitchDependencies;
	let mockSession: Session;
	let publishSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let setModelSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;
	let setModelTrackerSpy: ReturnType<typeof mock>;
	let restartQuerySpy: ReturnType<typeof mock>;
	let queryObject: { setModel: ReturnType<typeof mock> } | null;
	let transportReady: boolean;

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
		restartQuerySpy = mock(async () => {});

		queryObject = { setModel: setModelSpy };
		transportReady = true;

		mockDeps = {
			session: mockSession,
			db: {
				updateSession: updateSessionSpy,
			} as unknown as Database,
			messageHub: {
				publish: publishSpy,
			} as unknown as MessageHub,
			daemonHub: {
				emit: emitSpy,
			} as unknown as DaemonHub,
			contextTracker: {
				setModel: setModelTrackerSpy,
			} as unknown as ContextTracker,
			stateManager: {
				getState: mock(() => ({ status: 'idle' })),
			} as unknown as ProcessingStateManager,
			errorManager: {
				handleError: handleErrorSpy,
			} as unknown as ErrorManager,
			logger: {
				log: mock(() => {}),
				error: mock(() => {}),
			} as unknown as Logger,
			getQueryObject: () => queryObject,
			isTransportReady: () => transportReady,
			restartQuery: restartQuerySpy,
		};

		handler = new ModelSwitchHandler(mockDeps);
	});

	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
		clearModelsCache();
	});

	describe('getCurrentModel', () => {
		it('should return current model info', () => {
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe('default');
			expect(modelInfo.info).toBeNull(); // Info is fetched async
		});

		it('should reflect session config model', () => {
			mockSession.config.model = 'opus';
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe('opus');
		});

		it('should return info as null (fetched asynchronously)', () => {
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo).toEqual({
				id: 'default',
				info: null,
			});
		});

		it('should track model changes in session config', () => {
			expect(handler.getCurrentModel().id).toBe('default');

			mockSession.config.model = 'haiku';
			expect(handler.getCurrentModel().id).toBe('haiku');

			mockSession.config.model = 'opus';
			expect(handler.getCurrentModel().id).toBe('opus');
		});
	});

	describe('constructor', () => {
		it('should accept all required dependencies', () => {
			const newHandler = new ModelSwitchHandler(mockDeps);
			expect(newHandler).toBeDefined();
			expect(newHandler.getCurrentModel).toBeDefined();
			expect(newHandler.switchModel).toBeDefined();
		});
	});

	describe('dependency usage', () => {
		it('should use session from dependencies', () => {
			const modelInfo = handler.getCurrentModel();
			expect(modelInfo.id).toBe(mockDeps.session.config.model);
		});

		it('should access query object via callback', () => {
			// Verify the dependency pattern works
			expect(mockDeps.getQueryObject()).toBe(queryObject);
		});

		it('should access transport ready state via callback', () => {
			expect(mockDeps.isTransportReady()).toBe(true);

			transportReady = false;
			expect(mockDeps.isTransportReady()).toBe(false);
		});
	});

	describe('switchModel', () => {
		// Use a valid model that's different from 'default'
		// 'opus' is a distinct model that will trigger actual switching
		const VALID_MODEL = 'opus';

		describe('when query not started', () => {
			beforeEach(() => {
				// Set query to null (not started)
				queryObject = null;
			});

			it('should update config only when query not started', async () => {
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(updateSessionSpy).toHaveBeenCalled();
				expect(setModelTrackerSpy).toHaveBeenCalled();
				expect(restartQuerySpy).not.toHaveBeenCalled();
			});

			it('should emit session.updated event', async () => {
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
			beforeEach(() => {
				transportReady = false;
			});

			it('should update config only when transport not ready', async () => {
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(updateSessionSpy).toHaveBeenCalled();
				expect(restartQuerySpy).not.toHaveBeenCalled();
			});
		});

		describe('when query is running', () => {
			it('should restart query when running', async () => {
				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(true);
				expect(restartQuerySpy).toHaveBeenCalled();
			});

			it('should update session config before restart', async () => {
				await handler.switchModel(VALID_MODEL);

				expect(updateSessionSpy).toHaveBeenCalled();
			});

			it('should fail if restartQuery not provided', async () => {
				mockDeps.restartQuery = undefined;
				handler = new ModelSwitchHandler(mockDeps);

				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(false);
				expect(result.error).toContain('restartQuery callback not provided');
			});
		});

		describe('validation', () => {
			it('should reject invalid model', async () => {
				const result = await handler.switchModel('invalid-model-12345');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid model');
				expect(result.model).toBe('default'); // Returns current model
			});

			it('should return success with message when already using model', async () => {
				// Switch to haiku first
				queryObject = null; // No query running for simpler test
				await handler.switchModel('haiku');
				// Then try to switch to haiku again
				const result = await handler.switchModel('haiku');

				expect(result.success).toBe(true);
				expect(result.error).toContain('Already using');
			});
		});

		describe('error handling', () => {
			it('should handle errors and call error manager', async () => {
				// Make restartQuery throw
				restartQuerySpy.mockRejectedValue(new Error('Restart failed'));

				const result = await handler.switchModel(VALID_MODEL);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Restart failed');
				expect(handleErrorSpy).toHaveBeenCalled();
			});
		});

		describe('context tracker update', () => {
			beforeEach(() => {
				// Set query to null so we don't need restart
				queryObject = null;
			});

			it('should update context tracker model', async () => {
				// Use haiku to ensure we're switching to a different model
				await handler.switchModel('haiku');

				expect(setModelTrackerSpy).toHaveBeenCalled();
			});
		});
	});
});
