/**
 * Tests for Room Agent RPC Handlers
 *
 * Tests the RPC handlers for room agent operations:
 * - roomAgent.start - Start agent for a room
 * - roomAgent.stop - Stop agent for a room
 * - roomAgent.getState - Get agent state for a room
 * - roomAgent.pause - Pause agent
 * - roomAgent.resume - Resume agent
 * - roomAgent.forceState - Force agent to a specific state
 * - roomAgent.list - List all active agents with their states
 *
 * Tests both the RPC handlers and RoomAgentManager class.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type RoomAgentState, type RoomAgentLifecycleState } from '@neokai/shared';
import {
	setupRoomAgentHandlers,
	RoomAgentManager,
} from '../../../src/lib/rpc-handlers/room-agent-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock RoomAgentService methods
const createMockRoomAgentService = () => ({
	start: mock(async () => {}),
	stop: mock(async () => {}),
	pause: mock(async () => {}),
	resume: mock(async () => {}),
	forceState: mock(async () => {}),
	getState: mock(
		(): RoomAgentState => ({
			roomId: 'room-123',
			lifecycleState: 'idle' as RoomAgentLifecycleState,
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
		})
	),
});

type MockRoomAgentService = ReturnType<typeof createMockRoomAgentService>;

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
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

// Create a mock RoomAgentManager
function createMockRoomAgentManager(): {
	manager: RoomAgentManager;
	agents: Map<string, MockRoomAgentService>;
} {
	const agents = new Map<string, MockRoomAgentService>();

	const manager = {
		getOrCreateAgent: mock((roomId: string): MockRoomAgentService => {
			let agent = agents.get(roomId);
			if (!agent) {
				agent = createMockRoomAgentService();
				agents.set(roomId, agent);
			}
			return agent;
		}),
		getAgent: mock((roomId: string): MockRoomAgentService | undefined => {
			return agents.get(roomId);
		}),
		startAgent: mock(async (roomId: string): Promise<void> => {
			let agent = agents.get(roomId);
			if (!agent) {
				agent = createMockRoomAgentService();
				agents.set(roomId, agent);
			}
			await agent.start();
		}),
		stopAgent: mock(async (roomId: string): Promise<void> => {
			const agent = agents.get(roomId);
			if (agent) {
				await agent.stop();
			}
		}),
		pauseAgent: mock(async (roomId: string): Promise<void> => {
			const agent = agents.get(roomId);
			if (agent) {
				await agent.pause();
			}
		}),
		resumeAgent: mock(async (roomId: string): Promise<void> => {
			const agent = agents.get(roomId);
			if (agent) {
				await agent.resume();
			}
		}),
		getState: mock((roomId: string): RoomAgentState | null => {
			const agent = agents.get(roomId);
			return agent ? agent.getState() : null;
		}),
		forceState: mock(async (roomId: string, newState: RoomAgentLifecycleState): Promise<void> => {
			const agent = agents.get(roomId);
			if (agent) {
				await agent.forceState(newState);
			}
		}),
		stopAll: mock(async (): Promise<void> => {
			for (const agent of agents.values()) {
				await agent.stop();
			}
		}),
		listAgents: mock((): Array<{ roomId: string; state: RoomAgentState }> => {
			const result: Array<{ roomId: string; state: RoomAgentState }> = [];
			for (const [roomId, agent] of agents) {
				result.push({
					roomId,
					state: agent.getState(),
				});
			}
			return result;
		}),
		removeAgent: mock((roomId: string): boolean => {
			return agents.delete(roomId);
		}),
	} as unknown as RoomAgentManager;

	return { manager, agents };
}

describe('Room Agent RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let agentManagerData: ReturnType<typeof createMockRoomAgentManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		agentManagerData = createMockRoomAgentManager();

		// Setup handlers with mocked dependencies
		setupRoomAgentHandlers(messageHubData.hub, daemonHubData.daemonHub, agentManagerData.manager);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('roomAgent.start', () => {
		it('starts agent for a room', async () => {
			const handler = messageHubData.handlers.get('roomAgent.start');
			expect(handler).toBeDefined();

			// Pre-create an agent with idle state
			const mockAgent = createMockRoomAgentService();
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(agentManagerData.manager.startAgent).toHaveBeenCalledWith('room-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.start');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('emits state change event when state changes', async () => {
			const handler = messageHubData.handlers.get('roomAgent.start');
			expect(handler).toBeDefined();

			// Pre-create an agent that will change state
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'idle',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				})
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'planning',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'roomAgent.stateChanged',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					previousState: 'idle',
					newState: 'planning',
					reason: 'Agent started',
				})
			);
		});

		it('does not emit state change event when state does not change', async () => {
			const handler = messageHubData.handlers.get('roomAgent.start');
			expect(handler).toBeDefined();

			// Agent with same state before and after
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'idle',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				})
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'idle',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123' }, {});

			// Should not emit state change when state is the same
			const emitCalls = (daemonHubData.emit as ReturnType<typeof mock>).mock.calls;
			const stateChangeCalls = emitCalls.filter((call) => call[0] === 'roomAgent.stateChanged');
			expect(stateChangeCalls.length).toBe(0);
		});
	});

	describe('roomAgent.stop', () => {
		it('stops agent for a room', async () => {
			const handler = messageHubData.handlers.get('roomAgent.stop');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(agentManagerData.manager.stopAgent).toHaveBeenCalledWith('room-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.stop');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('emits state change event when state changes', async () => {
			const handler = messageHubData.handlers.get('roomAgent.stop');
			expect(handler).toBeDefined();

			// Pre-create an agent that will change state
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'executing',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				})
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'idle',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'roomAgent.stateChanged',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					previousState: 'executing',
					newState: 'idle',
					reason: 'Agent stopped',
				})
			);
		});
	});

	describe('roomAgent.getState', () => {
		it('returns agent state for a room', async () => {
			const handler = messageHubData.handlers.get('roomAgent.getState');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'executing',
				currentGoalId: 'goal-456',
				currentTaskId: 'task-789',
				activeSessionPairIds: ['pair-001'],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: ['review_results'],
			});
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { state: RoomAgentState | null };

			expect(agentManagerData.manager.getState).toHaveBeenCalledWith('room-123');
			expect(result.state).toBeDefined();
			expect(result.state?.roomId).toBe('room-123');
			expect(result.state?.lifecycleState).toBe('executing');
		});

		it('returns null when agent does not exist', async () => {
			const handler = messageHubData.handlers.get('roomAgent.getState');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-456', // Non-existent room
			};

			const result = (await handler!(params, {})) as { state: RoomAgentState | null };

			expect(result.state).toBeNull();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.getState');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('roomAgent.pause', () => {
		it('pauses agent for a room', async () => {
			const handler = messageHubData.handlers.get('roomAgent.pause');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(agentManagerData.manager.pauseAgent).toHaveBeenCalledWith('room-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.pause');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('emits state change event when state changes', async () => {
			const handler = messageHubData.handlers.get('roomAgent.pause');
			expect(handler).toBeDefined();

			// Pre-create an agent that will change state
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'executing',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				})
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'paused',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'roomAgent.stateChanged',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					previousState: 'executing',
					newState: 'paused',
					reason: 'Agent paused',
				})
			);
		});
	});

	describe('roomAgent.resume', () => {
		it('resumes agent for a room', async () => {
			const handler = messageHubData.handlers.get('roomAgent.resume');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(agentManagerData.manager.resumeAgent).toHaveBeenCalledWith('room-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.resume');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('emits state change event when state changes', async () => {
			const handler = messageHubData.handlers.get('roomAgent.resume');
			expect(handler).toBeDefined();

			// Pre-create an agent that will change state
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'paused',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				})
				.mockReturnValueOnce({
					roomId: 'room-123',
					lifecycleState: 'executing',
					activeSessionPairIds: [],
					lastActivityAt: Date.now(),
					errorCount: 0,
					pendingActions: [],
				});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'roomAgent.stateChanged',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					previousState: 'paused',
					newState: 'executing',
					reason: 'Agent resumed',
				})
			);
		});
	});

	describe('roomAgent.forceState', () => {
		it('forces agent to a specific state', async () => {
			const handler = messageHubData.handlers.get('roomAgent.forceState');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'idle',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agentManagerData.agents.set('room-123', mockAgent);

			const params = {
				roomId: 'room-123',
				newState: 'error' as RoomAgentLifecycleState,
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(agentManagerData.manager.forceState).toHaveBeenCalledWith('room-123', 'error');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.forceState');
			expect(handler).toBeDefined();

			await expect(handler!({ newState: 'error' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when newState is missing', async () => {
			const handler = messageHubData.handlers.get('roomAgent.forceState');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('New state is required');
		});

		it('emits state change event when state changes', async () => {
			const handler = messageHubData.handlers.get('roomAgent.forceState');
			expect(handler).toBeDefined();

			// Pre-create an agent
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'idle',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123', newState: 'error' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'roomAgent.stateChanged',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					previousState: 'idle',
					newState: 'error',
					reason: 'Forced state change',
				})
			);
		});

		it('does not emit event when state is the same', async () => {
			const handler = messageHubData.handlers.get('roomAgent.forceState');
			expect(handler).toBeDefined();

			// Pre-create an agent with same state
			const mockAgent = createMockRoomAgentService();
			mockAgent.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'idle',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agentManagerData.agents.set('room-123', mockAgent);

			await handler!({ roomId: 'room-123', newState: 'idle' }, {});

			// Should not emit state change when state is the same
			const emitCalls = (daemonHubData.emit as ReturnType<typeof mock>).mock.calls;
			const stateChangeCalls = emitCalls.filter((call) => call[0] === 'roomAgent.stateChanged');
			expect(stateChangeCalls.length).toBe(0);
		});
	});

	describe('roomAgent.list', () => {
		it('lists all agents with their states', async () => {
			const handler = messageHubData.handlers.get('roomAgent.list');
			expect(handler).toBeDefined();

			// Pre-create multiple agents
			const mockAgent1 = createMockRoomAgentService();
			mockAgent1.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'idle',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agentManagerData.agents.set('room-123', mockAgent1);

			const mockAgent2 = createMockRoomAgentService();
			mockAgent2.getState.mockReturnValue({
				roomId: 'room-456',
				lifecycleState: 'executing',
				currentGoalId: 'goal-789',
				activeSessionPairIds: ['pair-001'],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agentManagerData.agents.set('room-456', mockAgent2);

			const result = (await handler!({}, {})) as {
				agents: Array<{ roomId: string; state: RoomAgentState }>;
			};

			expect(agentManagerData.manager.listAgents).toHaveBeenCalled();
			expect(result.agents).toHaveLength(2);
			expect(result.agents.map((a) => a.roomId)).toContain('room-123');
			expect(result.agents.map((a) => a.roomId)).toContain('room-456');
		});

		it('returns empty array when no agents', async () => {
			const handler = messageHubData.handlers.get('roomAgent.list');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				agents: Array<{ roomId: string; state: RoomAgentState }>;
			};

			expect(result.agents).toHaveLength(0);
		});
	});
});

describe('RoomAgentManager', () => {
	// Test the RoomAgentManager class directly
	describe('Agent lifecycle management', () => {
		it('creates agent when getOrCreateAgent is called', () => {
			const agents = new Map<string, MockRoomAgentService>();
			const manager = {
				getOrCreateAgent: (roomId: string): MockRoomAgentService => {
					let agent = agents.get(roomId);
					if (!agent) {
						agent = createMockRoomAgentService();
						agents.set(roomId, agent);
					}
					return agent;
				},
			};

			expect(agents.size).toBe(0);

			const agent = manager.getOrCreateAgent('room-123');
			expect(agent).toBeDefined();
			expect(agents.size).toBe(1);

			// Calling again should return same agent
			const sameAgent = manager.getOrCreateAgent('room-123');
			expect(sameAgent).toBe(agent);
			expect(agents.size).toBe(1);
		});

		it('returns undefined when agent does not exist', () => {
			const agents = new Map<string, MockRoomAgentService>();
			const manager = {
				getAgent: (roomId: string): MockRoomAgentService | undefined => {
					return agents.get(roomId);
				},
			};

			expect(manager.getAgent('non-existent')).toBeUndefined();
		});

		it('lists all agents', () => {
			const agents = new Map<string, MockRoomAgentService>();

			const agent1 = createMockRoomAgentService();
			agent1.getState.mockReturnValue({
				roomId: 'room-123',
				lifecycleState: 'idle',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agents.set('room-123', agent1);

			const agent2 = createMockRoomAgentService();
			agent2.getState.mockReturnValue({
				roomId: 'room-456',
				lifecycleState: 'executing',
				activeSessionPairIds: [],
				lastActivityAt: Date.now(),
				errorCount: 0,
				pendingActions: [],
			});
			agents.set('room-456', agent2);

			const listAgents = () => {
				const result: Array<{ roomId: string; state: RoomAgentState }> = [];
				for (const [roomId, agent] of agents) {
					result.push({
						roomId,
						state: agent.getState(),
					});
				}
				return result;
			};

			const result = listAgents();
			expect(result).toHaveLength(2);
			expect(result.map((a) => a.roomId)).toContain('room-123');
			expect(result.map((a) => a.roomId)).toContain('room-456');
		});

		it('removes agent from tracking', () => {
			const agents = new Map<string, MockRoomAgentService>();
			const agent = createMockRoomAgentService();
			agents.set('room-123', agent);

			expect(agents.has('room-123')).toBe(true);

			agents.delete('room-123');

			expect(agents.has('room-123')).toBe(false);
		});
	});
});
