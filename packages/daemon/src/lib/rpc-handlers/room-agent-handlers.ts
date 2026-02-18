/**
 * Room Agent RPC Handlers
 *
 * RPC handlers for room agent operations:
 * - roomAgent.start - Start agent for a room
 * - roomAgent.stop - Stop agent for a room
 * - roomAgent.getState - Get agent state for a room
 * - roomAgent.pause - Pause agent
 * - roomAgent.resume - Resume agent
 * - roomAgent.forceState - Force agent to a specific state
 * - roomAgent.list - List all active agents with their states
 *
 * Includes RoomAgentManager class to track active RoomAgentService instances.
 */

import type { MessageHub } from '@neokai/shared';
import type { RoomAgentState, RoomAgentLifecycleState } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database as BunDatabase } from 'bun:sqlite';
import { RoomAgentService, type RoomAgentContext } from '../room/room-agent-service';
import { RoomManager } from '../room/room-manager';
import type { SessionPairManager } from '../room/session-pair-manager';
import { TaskManager } from '../room/task-manager';
import { GoalManager } from '../room/goal-manager';
import { RecurringJobScheduler } from '../room/recurring-job-scheduler';

/**
 * Factory types for creating per-room managers
 */
export type TaskManagerFactory = (roomId: string) => TaskManager;
export type GoalManagerFactory = (roomId: string) => GoalManager;

/**
 * RecurringJobScheduler interface for dependency injection
 */
export type RecurringJobSchedulerLike = Pick<
	RecurringJobScheduler,
	| 'start'
	| 'stop'
	| 'createJob'
	| 'getJob'
	| 'listJobs'
	| 'updateJob'
	| 'enableJob'
	| 'disableJob'
	| 'deleteJob'
	| 'triggerJob'
	| 'getStats'
>;

/**
 * Dependencies for RoomAgentManager
 */
export interface RoomAgentManagerDeps {
	db: BunDatabase;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	roomManager: RoomManager;
	sessionPairManager: SessionPairManager;
	taskManagerFactory: TaskManagerFactory;
	goalManagerFactory: GoalManagerFactory;
	scheduler: RecurringJobSchedulerLike;
}

/**
 * RoomAgentManager - Tracks active RoomAgentService instances
 *
 * Manages the lifecycle of room agents across all rooms.
 * Each room can have at most one active RoomAgentService.
 */
export class RoomAgentManager {
	private agents: Map<string, RoomAgentService> = new Map();

	constructor(private deps: RoomAgentManagerDeps) {}

	/**
	 * Get or create a RoomAgentService for a room
	 * Creates the agent if it doesn't exist
	 */
	getOrCreateAgent(roomId: string): RoomAgentService {
		let agent = this.agents.get(roomId);
		if (!agent) {
			agent = this.createAgent(roomId);
			this.agents.set(roomId, agent);
		}
		return agent;
	}

	/**
	 * Get an existing RoomAgentService (returns undefined if not created)
	 */
	getAgent(roomId: string): RoomAgentService | undefined {
		return this.agents.get(roomId);
	}

	/**
	 * Start the agent for a room
	 * Creates the agent if it doesn't exist, then starts it
	 */
	async startAgent(roomId: string): Promise<void> {
		const agent = this.getOrCreateAgent(roomId);
		await agent.start();
	}

	/**
	 * Stop the agent for a room
	 * The agent remains in memory but is stopped
	 */
	async stopAgent(roomId: string): Promise<void> {
		const agent = this.agents.get(roomId);
		if (agent) {
			await agent.stop();
		}
	}

	/**
	 * Pause the agent for a room
	 */
	async pauseAgent(roomId: string): Promise<void> {
		const agent = this.agents.get(roomId);
		if (agent) {
			await agent.pause();
		}
	}

	/**
	 * Resume the agent for a room
	 */
	async resumeAgent(roomId: string): Promise<void> {
		const agent = this.agents.get(roomId);
		if (agent) {
			await agent.resume();
		}
	}

	/**
	 * Get the state of an agent
	 * Returns null if agent doesn't exist
	 */
	getState(roomId: string): RoomAgentState | null {
		const agent = this.agents.get(roomId);
		return agent ? agent.getState() : null;
	}

	/**
	 * Force the agent to a specific state
	 */
	async forceState(roomId: string, newState: RoomAgentLifecycleState): Promise<void> {
		const agent = this.agents.get(roomId);
		if (agent) {
			await agent.forceState(newState);
		}
	}

	/**
	 * Stop all active agents
	 */
	async stopAll(): Promise<void> {
		const stopPromises = Array.from(this.agents.values()).map((agent) => agent.stop());
		await Promise.all(stopPromises);
	}

	/**
	 * List all agents with their states
	 */
	listAgents(): Array<{ roomId: string; state: RoomAgentState }> {
		const result: Array<{ roomId: string; state: RoomAgentState }> = [];
		for (const [roomId, agent] of this.agents) {
			result.push({
				roomId,
				state: agent.getState(),
			});
		}
		return result;
	}

	/**
	 * Remove an agent from tracking (does not stop it)
	 */
	removeAgent(roomId: string): boolean {
		return this.agents.delete(roomId);
	}

	/**
	 * Create a new RoomAgentService for a room
	 */
	private createAgent(roomId: string): RoomAgentService {
		const room = this.deps.roomManager.getRoom(roomId);
		if (!room) {
			throw new Error(`Room not found: ${roomId}`);
		}

		const context: RoomAgentContext = {
			room,
			db: this.deps.db,
			daemonHub: this.deps.daemonHub,
			messageHub: this.deps.messageHub,
			sessionPairManager: this.deps.sessionPairManager,
		};

		return new RoomAgentService(context);
	}
}

/**
 * Setup room agent RPC handlers
 */
export function setupRoomAgentHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	roomAgentManager: RoomAgentManager
): void {
	/**
	 * Emit roomAgent.stateChanged event to notify UI clients
	 */
	const emitStateChange = (
		roomId: string,
		previousState: RoomAgentLifecycleState,
		newState: RoomAgentLifecycleState,
		reason?: string
	) => {
		daemonHub
			.emit('roomAgent.stateChanged', {
				sessionId: `room:${roomId}`,
				roomId,
				previousState,
				newState,
				reason,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	// roomAgent.start - Start agent for a room
	messageHub.onRequest('roomAgent.start', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const previousState = roomAgentManager.getState(params.roomId)?.lifecycleState;
		await roomAgentManager.startAgent(params.roomId);
		const newState = roomAgentManager.getState(params.roomId)?.lifecycleState;

		if (previousState && newState && previousState !== newState) {
			emitStateChange(params.roomId, previousState, newState, 'Agent started');
		}

		return { success: true };
	});

	// roomAgent.stop - Stop agent for a room
	messageHub.onRequest('roomAgent.stop', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const previousState = roomAgentManager.getState(params.roomId)?.lifecycleState;
		await roomAgentManager.stopAgent(params.roomId);
		const newState = roomAgentManager.getState(params.roomId)?.lifecycleState;

		if (previousState && newState && previousState !== newState) {
			emitStateChange(params.roomId, previousState, newState, 'Agent stopped');
		}

		return { success: true };
	});

	// roomAgent.getState - Get agent state for a room
	messageHub.onRequest('roomAgent.getState', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const state = roomAgentManager.getState(params.roomId);
		return { state };
	});

	// roomAgent.pause - Pause agent for a room
	messageHub.onRequest('roomAgent.pause', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const previousState = roomAgentManager.getState(params.roomId)?.lifecycleState;
		await roomAgentManager.pauseAgent(params.roomId);
		const newState = roomAgentManager.getState(params.roomId)?.lifecycleState;

		if (previousState && newState && previousState !== newState) {
			emitStateChange(params.roomId, previousState, newState, 'Agent paused');
		}

		return { success: true };
	});

	// roomAgent.resume - Resume agent for a room
	messageHub.onRequest('roomAgent.resume', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const previousState = roomAgentManager.getState(params.roomId)?.lifecycleState;
		await roomAgentManager.resumeAgent(params.roomId);
		const newState = roomAgentManager.getState(params.roomId)?.lifecycleState;

		if (previousState && newState && previousState !== newState) {
			emitStateChange(params.roomId, previousState, newState, 'Agent resumed');
		}

		return { success: true };
	});

	// roomAgent.forceState - Force agent to a specific state
	messageHub.onRequest('roomAgent.forceState', async (data) => {
		const params = data as { roomId: string; newState: RoomAgentLifecycleState };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.newState) {
			throw new Error('New state is required');
		}

		const previousState = roomAgentManager.getState(params.roomId)?.lifecycleState;
		await roomAgentManager.forceState(params.roomId, params.newState);

		if (previousState && previousState !== params.newState) {
			emitStateChange(params.roomId, previousState, params.newState, 'Forced state change');
		}

		return { success: true };
	});

	// roomAgent.list - List all active agents with their states
	messageHub.onRequest('roomAgent.list', async () => {
		const agents = roomAgentManager.listAgents();
		return { agents };
	});
}
