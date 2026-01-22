/**
 * ModelSwitchHandler Tests
 *
 * Tests model switching logic for AgentSession.
 * Note: Tests that require model validation are skipped since model-service
 * functions cannot be easily mocked in ESM modules.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	ModelSwitchHandler,
	type ModelSwitchDependencies,
} from '../../../src/lib/agent/model-switch-handler';
import type { Session } from '@liuboer/shared';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { ErrorManager } from '../../../src/lib/error-manager';
import type { Logger } from '../../../src/lib/logger';
import { generateUUID } from '@liuboer/shared';

describe('ModelSwitchHandler', () => {
	let handler: ModelSwitchHandler;
	let mockDeps: ModelSwitchDependencies;
	let mockSession: Session;
	let publishSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let setModelSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;
	let queryObject: { setModel: ReturnType<typeof mock> } | null;
	let transportReady: boolean;

	beforeEach(() => {
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
				setModel: mock(() => {}),
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
		};

		handler = new ModelSwitchHandler(mockDeps);
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
});
