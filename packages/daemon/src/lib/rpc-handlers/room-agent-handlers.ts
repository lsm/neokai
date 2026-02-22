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

import type { MessageHub, McpServerConfig } from '@neokai/shared';
import type { RoomAgentState, RoomAgentLifecycleState, RoomAgentHumanInput } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SettingsManager } from '../settings-manager';
import type { Database } from '../../storage/index';
import { RoomAgentService, type RoomAgentContext } from '../room/room-agent-service';
import { RoomManager } from '../room/room-manager';
import type { SessionPairManager } from '../room/session-pair-manager';
import { TaskManager } from '../room/task-manager';
import { GoalManager } from '../room/goal-manager';
import { RecurringJobScheduler } from '../room/recurring-job-scheduler';
import type { PromptTemplateManager } from '../prompts/prompt-template-manager';
import type { SessionManager } from '../session-manager';

/**
 * Global registry for in-process MCP servers
 * This allows QueryOptionsBuilder to access MCP servers created by RoomAgentManager
 */
const globalMcpServerRegistry = new Map<
	string,
	ReturnType<typeof import('../agent/room-agent-tools').createRoomAgentMcpServer>
>();

/**
 * Register an in-process MCP server for a room
 */
export function registerRoomMcpServer(
	roomId: string,
	mcpServer: ReturnType<typeof import('../agent/room-agent-tools').createRoomAgentMcpServer>
): void {
	globalMcpServerRegistry.set(roomId, mcpServer);
}

/**
 * Get an in-process MCP server for a room
 */
export function getRoomMcpServer(
	roomId: string
): ReturnType<typeof import('../agent/room-agent-tools').createRoomAgentMcpServer> | undefined {
	return globalMcpServerRegistry.get(roomId);
}

/**
 * Unregister an in-process MCP server for a room
 */
export function unregisterRoomMcpServer(roomId: string): void {
	globalMcpServerRegistry.delete(roomId);
}

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
	db: Database;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	roomManager: RoomManager;
	sessionPairManager: SessionPairManager;
	taskManagerFactory: TaskManagerFactory;
	goalManagerFactory: GoalManagerFactory;
	scheduler: RecurringJobSchedulerLike;
	/** API key provider function */
	getApiKey: () => Promise<string | null>;
	/** Prompt template manager */
	promptTemplateManager: PromptTemplateManager;
	/** Settings manager for global configuration */
	settingsManager: SettingsManager;
	/** Default workspace root from server config */
	workspaceRoot?: string;
	/** Session manager for updating room chat sessions */
	sessionManager?: SessionManager;
}

/**
 * RoomAgentManager - Tracks active RoomAgentService instances
 *
 * Manages the lifecycle of room agents across all rooms.
 * Each room can have at most one active RoomAgentService.
 */
export class RoomAgentManager {
	private agents: Map<string, RoomAgentService> = new Map();
	/** Runtime-only mapping of room IDs to their MCP servers */
	private roomMcpServers: Map<
		string,
		ReturnType<typeof import('../agent/room-agent-tools').createRoomAgentMcpServer>
	> = new Map();

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

		// After the agent starts, update the room chat session with the MCP server
		await this.updateRoomChatSessionWithMcpServer(roomId);
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
		this.roomMcpServers.delete(roomId);
		unregisterRoomMcpServer(roomId);
		return this.agents.delete(roomId);
	}

	/**
	 * Get the MCP server for a room (runtime only)
	 */
	getRoomMcpServer(
		roomId: string
	): ReturnType<typeof import('../agent/room-agent-tools').createRoomAgentMcpServer> | undefined {
		return this.roomMcpServers.get(roomId);
	}

	/**
	 * Update the room chat session with the room-agent-tools MCP server marker
	 * This should be called after the room agent starts to ensure the MCP server is available
	 */
	async updateRoomChatSessionWithMcpServer(roomId: string): Promise<void> {
		const agent = this.agents.get(roomId);
		if (!agent) {
			// Agent hasn't been created yet
			return;
		}

		const mcpServer = agent.getMcpServer();
		if (!mcpServer) {
			// MCP server hasn't been created yet (agent not started)
			return;
		}

		// Store the MCP server reference in runtime-only mapping
		this.roomMcpServers.set(roomId, mcpServer);
		// Register globally so QueryOptionsBuilder can access it
		registerRoomMcpServer(roomId, mcpServer);

		const sessionId = `room:${roomId}`;

		// Get the session from the database
		const session = this.deps.db.getSession(sessionId);
		if (!session) {
			// Session doesn't exist yet
			return;
		}

		// Store a marker in the config to indicate that this session should use
		// the room-agent-tools MCP server. The actual MCP server will be injected
		// at query time by QueryOptionsBuilder.
		this.deps.db.updateSession(sessionId, {
			config: {
				...session.config,
				mcpServers: {
					...session.config.mcpServers,
					'room-agent-tools': {
						type: '__IN_PROCESS_ROOM_AGENT_TOOLS__',
						roomId,
					} as unknown as McpServerConfig,
				},
			},
		});

		// Emit event to notify that session was updated
		await this.deps.daemonHub.emit('session.updated', {
			sessionId,
			source: 'mcp_config',
			session: {},
		});
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
			roomManager: this.deps.roomManager,
			getApiKey: this.deps.getApiKey,
			promptTemplateManager: this.deps.promptTemplateManager,
			recurringJobScheduler: this.deps.scheduler as RecurringJobScheduler,
			workspaceRoot: this.deps.workspaceRoot,
		};

		const settings = this.deps.settingsManager.getGlobalSettings();
		return new RoomAgentService(context, {
			maxConcurrentPairs: settings.maxConcurrentWorkers ?? 3,
		});
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

	// roomAgent.humanInput - Unified human input endpoint for room agent
	messageHub.onRequest('roomAgent.humanInput', async (data) => {
		const params = data as { roomId: string } & RoomAgentHumanInput;

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const agent = roomAgentManager.getAgent(params.roomId);
		if (!agent) {
			throw new Error('Room agent not found');
		}

		switch (params.type) {
			case 'message':
				if (!params.content) {
					throw new Error('Message content is required');
				}
				await agent.handleHumanInput({ type: 'message', content: params.content });
				break;
			case 'review_response':
				if (!params.taskId) {
					throw new Error('Task ID is required');
				}
				await agent.handleHumanInput({
					type: 'review_response',
					taskId: params.taskId,
					approved: params.approved,
					response: params.response ?? '',
				});
				break;
			case 'escalation_response':
				if (!params.escalationId) {
					throw new Error('Escalation ID is required');
				}
				await agent.handleHumanInput({
					type: 'escalation_response',
					escalationId: params.escalationId,
					response: params.response,
				});
				break;
			case 'question_response':
				if (!params.questionId) {
					throw new Error('Question ID is required');
				}
				await agent.handleHumanInput({
					type: 'question_response',
					questionId: params.questionId,
					responses: params.responses,
				});
				break;
			default:
				throw new Error(`Unsupported input type: ${(params as { type: string }).type}`);
		}

		return { success: true };
	});

	// roomAgent.submitReview - Submit a review response (approve/reject)
	messageHub.onRequest('roomAgent.submitReview', async (data) => {
		const params = data as {
			roomId: string;
			taskId: string;
			approved: boolean;
			response: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const agent = roomAgentManager.getAgent(params.roomId);
		if (!agent) {
			throw new Error('Room agent not found');
		}

		await agent.handleHumanInput({
			type: 'review_response',
			taskId: params.taskId,
			approved: params.approved,
			response: params.response,
		});

		return { success: true };
	});

	// roomAgent.resolveEscalation - Resolve an escalation
	messageHub.onRequest('roomAgent.resolveEscalation', async (data) => {
		const params = data as {
			roomId: string;
			escalationId: string;
			response: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.escalationId) {
			throw new Error('Escalation ID is required');
		}

		const agent = roomAgentManager.getAgent(params.roomId);
		if (!agent) {
			throw new Error('Room agent not found');
		}

		await agent.handleHumanInput({
			type: 'escalation_response',
			escalationId: params.escalationId,
			response: params.response,
		});

		return { success: true };
	});

	// roomAgent.sendMessage - Send a message to the room agent (human chat)
	messageHub.onRequest('roomAgent.sendMessage', async (data) => {
		const params = data as {
			roomId: string;
			message: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.message) {
			throw new Error('Message is required');
		}

		const agent = roomAgentManager.getAgent(params.roomId);
		if (!agent) {
			throw new Error('Room agent not found');
		}

		await agent.handleHumanInput({
			type: 'message',
			content: params.message,
		});

		return { success: true };
	});

	// roomAgent.getWaitingContext - Get what the agent is waiting for
	messageHub.onRequest('roomAgent.getWaitingContext', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const agent = roomAgentManager.getAgent(params.roomId);
		if (!agent) {
			return { waitingContext: null };
		}

		const waitingContext = agent.getWaitingContext();
		return { waitingContext };
	});
}
