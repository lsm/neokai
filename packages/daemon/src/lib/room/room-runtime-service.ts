/**
 * RoomRuntimeService - Wires RoomRuntime instances into the daemon
 *
 * Manages one RoomRuntime per room. Implements SessionFactory using real
 * AgentSession.fromInit() calls, attaches Room Agent MCP tools to room
 * chat sessions, and subscribes to DaemonHub events for goal/task changes.
 *
 * Follows the LobbyAgentService pattern.
 */

import type { Room, McpServerConfig } from '@neokai/shared';
import type { Database } from '../../storage/database';
import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionManager } from '../session-manager';
import type { SessionFactory } from './task-pair-manager';
import { RoomRuntime } from './room-runtime';
import { SessionObserver } from './session-observer';
import { SessionGroupRepository } from './session-group-repository';
import { TaskManager } from './task-manager';
import { GoalManager } from './goal-manager';
import { ConversationSessionWriter } from './conversation-session';
import { TurnTracker } from './turn-tracker';
import { AgentSession } from '../agent/agent-session';
import { createRoomAgentMcpServer } from './room-agent-tools';
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
import { recoverRuntime, type SessionStateChecker } from './runtime-recovery';
import type { RoomManager } from './room-manager';
import { Logger } from '../logger';

const log = new Logger('room-runtime-service');

export interface RoomRuntimeServiceConfig {
	db: Database;
	messageHub: MessageHub;
	daemonHub: DaemonHub;
	getApiKey: () => Promise<string | null>;
	roomManager: RoomManager;
	sessionManager: SessionManager;
	defaultWorkspacePath: string;
	defaultModel: string;
}

export class RoomRuntimeService {
	private runtimes = new Map<string, RoomRuntime>();
	private observers = new Map<string, SessionObserver>();
	private craftLeadSessions = new Map<string, AgentSession>();
	private unsubscribers: Array<() => void> = [];

	constructor(private ctx: RoomRuntimeServiceConfig) {}

	async start(): Promise<void> {
		this.subscribeToEvents();
		await this.initializeExistingRooms();
		log.info('RoomRuntimeService started');
	}

	stop(): void {
		for (const runtime of this.runtimes.values()) {
			runtime.stop();
		}
		this.runtimes.clear();
		this.observers.clear();
		this.craftLeadSessions.clear();

		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		log.info('RoomRuntimeService stopped');
	}

	private createSessionFactory(): SessionFactory {
		const ctx = this.ctx;
		const craftLeadSessions = this.craftLeadSessions;

		return {
			createAndStartSession: async (init, _role) => {
				const session = AgentSession.fromInit(
					init,
					ctx.db,
					ctx.messageHub,
					ctx.daemonHub,
					ctx.getApiKey,
					ctx.defaultModel
				);
				craftLeadSessions.set(init.sessionId, session);
				await session.startStreamingQuery();
			},
			injectMessage: async (sessionId, message) => {
				const session = craftLeadSessions.get(sessionId);
				if (!session) {
					throw new Error(`Session not in service cache: ${sessionId}`);
				}
				await session.messageQueue.enqueue(message, true);
			},
		};
	}

	private createOrGetRuntime(room: Room): RoomRuntime {
		const existing = this.runtimes.get(room.id);
		if (existing) return existing;

		const rawDb = this.ctx.db.getDatabase();
		const groupRepo = new SessionGroupRepository(rawDb);
		const taskManager = new TaskManager(rawDb, room.id);
		const goalManager = new GoalManager(rawDb, room.id);
		const sdkMessageRepo = new SDKMessageRepository(rawDb);
		const observer = new SessionObserver(this.ctx.daemonHub);
		const sessionFactory = this.createSessionFactory();
		const convWriter = new ConversationSessionWriter(rawDb, this.ctx.messageHub);
		const turnTracker = new TurnTracker();

		const workspacePath = room.defaultPath ?? this.ctx.defaultWorkspacePath;

		const runtime = new RoomRuntime({
			room,
			groupRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath,
			model: this.ctx.defaultModel,
			getCraftMessages: (sessionId, afterMessageId) =>
				sdkMessageRepo.getAssistantMessagesSince(sessionId, afterMessageId),
			daemonHub: this.ctx.daemonHub,
			convWriter,
			turnTracker,
		});

		this.runtimes.set(room.id, runtime);
		this.observers.set(room.id, observer);

		this.setupRoomAgentSession(room, groupRepo, taskManager, goalManager);
		runtime.start();

		return runtime;
	}

	private setupRoomAgentSession(
		room: Room,
		groupRepo: SessionGroupRepository,
		taskManager: TaskManager,
		goalManager: GoalManager
	): void {
		const roomChatSessionId = `room:chat:${room.id}`;
		const roomAgentMcpServer = createRoomAgentMcpServer({
			roomId: room.id,
			goalManager,
			taskManager,
			groupRepo,
		}) as unknown as McpServerConfig;

		// Reuse the SessionManager-owned room chat AgentSession to avoid duplicate
		// DaemonHub subscriptions and duplicate query execution.
		void this.ctx.sessionManager
			.getSessionAsync(roomChatSessionId)
			.then((roomChatSession) => {
				if (!roomChatSession) {
					log.warn(`Room chat session not found for room ${room.id}`);
					return;
				}
				roomChatSession.setRuntimeMcpServers({
					'room-agent-tools': roomAgentMcpServer,
				});
			})
			.catch((error) => {
				log.error(`Failed to attach room MCP tools for room ${room.id}:`, error);
			});
	}

	private subscribeToEvents(): void {
		// room.created is emitted with sessionId: 'global'
		const unsubRoomCreated = this.ctx.daemonHub.on(
			'room.created',
			(event) => {
				this.createOrGetRuntime(event.room);
			},
			{ sessionId: 'global' }
		);
		this.unsubscribers.push(unsubRoomCreated);

		// goal.created is emitted with sessionId: 'room:${roomId}' — subscribe globally
		const unsubGoalCreated = this.ctx.daemonHub.on('goal.created', (event) => {
			this.runtimes.get(event.roomId)?.onGoalCreated(event.goalId);
		});
		this.unsubscribers.push(unsubGoalCreated);

		// room.task.update is emitted with sessionId: 'room:${roomId}' — subscribe globally
		const unsubTaskUpdate = this.ctx.daemonHub.on('room.task.update', (event) => {
			this.runtimes.get(event.roomId)?.onTaskStatusChanged(event.task.id);
		});
		this.unsubscribers.push(unsubTaskUpdate);
	}

	private async initializeExistingRooms(): Promise<void> {
		const rooms = this.ctx.roomManager.listRooms();
		for (const room of rooms) {
			try {
				const runtime = this.createOrGetRuntime(room);
				const observer = this.observers.get(room.id)!;
				await this.recoverRoomRuntime(room.id, runtime, observer);
			} catch (error) {
				log.error(`Failed to initialize runtime for room ${room.id}:`, error);
			}
		}
	}

	private async recoverRoomRuntime(
		roomId: string,
		runtime: RoomRuntime,
		observer: SessionObserver
	): Promise<void> {
		const rawDb = this.ctx.db.getDatabase();
		const groupRepo = new SessionGroupRepository(rawDb);
		const taskManager = new TaskManager(rawDb, roomId);

		const checker: SessionStateChecker = {
			sessionExists: (sessionId) => this.ctx.db.getSession(sessionId) !== null,
			// Assume not terminal after restart — active pairs stuck post-restart
			// can be cancelled via the cancel_task Room Agent tool.
			isTerminalState: () => false,
		};

		try {
			const result = await recoverRuntime(
				roomId,
				groupRepo,
				taskManager,
				observer,
				checker,
				runtime
			);
			if (result.recoveredPairs > 0) {
				log.info(
					`Room ${roomId}: recovered ${result.recoveredPairs} pairs, ` +
						`failed ${result.failedPairs}, reattached ${result.reattachedObservers} observers`
				);
			}
		} catch (error) {
			log.error(`Failed to recover runtime for room ${roomId}:`, error);
		}
	}
}
