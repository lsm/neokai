/**
 * Tests for Room Runtime Model Handlers
 *
 * Tests the RPC handlers for room runtime model operations:
 * - room.runtime.model.get - Get current model for a task session
 * - room.runtime.model.switch - Switch model for a task session
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import type { MessageHub, DaemonHub } from '@neokai/shared';
import { setupRoomRuntimeHandlers } from '../../../../src/lib/rpc-handlers/room-handlers';
import type { RoomRuntimeService } from '../../../../src/lib/room/runtime/room-runtime-service';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emitMock: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emitMock };
}

describe('RoomRuntimeModel Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let mockAgentSession: AgentSession;
	let mockRoomRuntimeService: RoomRuntimeService;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();

		// Create mock AgentSession
		mockAgentSession = {
			getSessionData: mock(() => ({
				id: 'test-session-123',
				config: {
					model: 'claude-sonnet-4-6',
					provider: 'anthropic',
				},
			})),
			handleModelSwitch: mock(async (model: string, provider: string) => ({
				success: true,
				model,
				provider,
			})),
		} as unknown as AgentSession;

		// Create mock RoomRuntimeService
		mockRoomRuntimeService = {
			modelGet: mock(async (sessionId: string) => {
				if (sessionId === 'non-existent') return null;
				return {
					currentModel: 'claude-sonnet-4-6',
					provider: 'anthropic',
				};
			}),
			modelSwitch: mock(
				async (
					sessionId: string,
					model: string,
					provider: string
				): Promise<{ success: boolean; model: string; error?: string }> => {
					if (sessionId === 'non-existent') {
						return { success: false, model: '', error: 'Session not found in runtime' };
					}
					if (sessionId === 'switch-error') {
						return { success: false, model: '', error: 'Model switch failed' };
					}
					return { success: true, model };
				}
			),
		} as unknown as RoomRuntimeService;

		// Setup handlers with mocked dependencies
		setupRoomRuntimeHandlers(messageHubData.hub, daemonHubData.daemonHub, mockRoomRuntimeService);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('room.runtime.model.get', () => {
		it('returns model info for existing session', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.get');
			expect(handler).toBeDefined();

			const result = (await handler!({ sessionId: 'test-session-123' }, {})) as {
				currentModel: string;
				provider: string;
			};

			expect(result.currentModel).toBe('claude-sonnet-4-6');
			expect(result.provider).toBe('anthropic');
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.get');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Session ID is required');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.get');
			expect(handler).toBeDefined();

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found in runtime'
			);
		});
	});

	describe('room.runtime.model.switch', () => {
		it('switches model successfully', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ sessionId: 'test-session-123', model: 'claude-opus-4', provider: 'anthropic' },
				{}
			)) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('claude-opus-4');
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(handler!({ model: 'claude-opus-4', provider: 'anthropic' }, {})).rejects.toThrow(
				'Session ID is required'
			);
		});

		it('throws error when model is missing', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(
				handler!({ sessionId: 'test-session-123', provider: 'anthropic' }, {})
			).rejects.toThrow('Model is required');
		});

		it('throws error when provider is missing', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(
				handler!({ sessionId: 'test-session-123', model: 'claude-opus-4' }, {})
			).rejects.toThrow('Provider is required');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(
				handler!({ sessionId: 'non-existent', model: 'claude-opus-4', provider: 'anthropic' }, {})
			).rejects.toThrow('Session not found in runtime');
		});

		it('throws error when model switch fails', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(
				handler!({ sessionId: 'switch-error', model: 'claude-opus-4', provider: 'anthropic' }, {})
			).rejects.toThrow('Model switch failed');
		});

		it('emits session.updated event with correct payload on success', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ sessionId: 'test-session-123', model: 'claude-opus-4', provider: 'anthropic' },
				{}
			)) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(messageHubData.hub.event).toHaveBeenCalledTimes(1);
			expect(messageHubData.hub.event).toHaveBeenCalledWith(
				'session.updated',
				{ sessionId: 'test-session-123', model: 'claude-opus-4' },
				{ channel: 'session:test-session-123' }
			);
		});

		it('does not emit session.updated event when model switch fails', async () => {
			const handler = messageHubData.handlers.get('room.runtime.model.switch');
			expect(handler).toBeDefined();

			await expect(
				handler!({ sessionId: 'switch-error', model: 'claude-opus-4', provider: 'anthropic' }, {})
			).rejects.toThrow('Model switch failed');

			expect(messageHubData.hub.event).not.toHaveBeenCalled();
		});
	});
});
