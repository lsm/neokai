/**
 * RoomRuntimeService - Wires RoomRuntime instances into the daemon
 *
 * Manages one RoomRuntime per room. Implements SessionFactory using real
 * AgentSession.fromInit() calls, attaches Room Agent MCP tools to room
 * chat sessions, and subscribes to DaemonHub events for goal/task changes.
 *
 * Follows the LobbyAgentService pattern.
 */

import type { Room, McpServerConfig, RuntimeState } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../../storage/database';
import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../../daemon-hub';
import type { SessionManager } from '../../session-manager';
import type { SessionFactory } from './task-group-manager';
import { RoomRuntime, MAX_CONCURRENT_GROUPS_LIMIT, MAX_REVIEW_ROUNDS_LIMIT } from './room-runtime';
import { SessionObserver } from '../state/session-observer';
import { SessionGroupRepository } from '../state/session-group-repository';
import { TaskManager } from '../managers/task-manager';
import { GoalManager } from '../managers/goal-manager';
import { AgentSession } from '../../agent/agent-session';
import { createRoomAgentMcpServer } from '../tools/room-agent-tools';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository';
import { recoverRuntime, type SessionStateChecker } from './runtime-recovery';
import type { RoomManager } from '../managers/room-manager';
import { WorktreeManager } from '../../worktree-manager';
import { Logger } from '../../logger';

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
	private agentSessions = new Map<string, AgentSession>();
	private unsubscribers: Array<() => void> = [];

	constructor(private ctx: RoomRuntimeServiceConfig) {}

	async start(): Promise<void> {
		this.subscribeToEvents();
		await this.initializeExistingRooms();
		log.info('RoomRuntimeService started');
	}

	getRuntimeState(roomId: string): RuntimeState | null {
		const runtime = this.runtimes.get(roomId);
		return runtime ? runtime.getState() : null;
	}

	getRuntime(roomId: string): RoomRuntime | null {
		return this.runtimes.get(roomId) ?? null;
	}

	pauseRuntime(roomId: string): boolean {
		const runtime = this.runtimes.get(roomId);
		if (!runtime) return false;
		runtime.pause();
		return true;
	}

	resumeRuntime(roomId: string): boolean {
		const runtime = this.runtimes.get(roomId);
		if (!runtime) return false;
		runtime.resume();
		return true;
	}

	stopRuntime(roomId: string): boolean {
		const runtime = this.runtimes.get(roomId);
		if (!runtime) return false;
		runtime.stop();
		return true;
	}

	/**
	 * Start (or restart) a runtime for a room.
	 * After stop(), the old runtime is disposed, so we remove it and create a fresh one.
	 */
	startRuntime(roomId: string): boolean {
		const room = this.ctx.roomManager.getRoom(roomId);
		if (!room) return false;

		// Remove old stopped runtime if it exists
		const existing = this.runtimes.get(roomId);
		if (existing) {
			if (existing.getState() !== 'stopped') {
				existing.stop();
			}
			this.runtimes.delete(roomId);
			this.observers.delete(roomId);
		}

		// Create a fresh runtime (which calls start() internally)
		this.createOrGetRuntime(room);
		return true;
	}

	stop(): void {
		for (const runtime of this.runtimes.values()) {
			runtime.stop();
		}
		this.runtimes.clear();
		this.observers.clear();
		this.agentSessions.clear();

		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		log.info('RoomRuntimeService stopped');
	}

	private createSessionFactory(): SessionFactory {
		const ctx = this.ctx;
		const agentSessions = this.agentSessions;
		const worktreeManager = new WorktreeManager();

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
				agentSessions.set(init.sessionId, session);
				await session.startStreamingQuery();
			},
			injectMessage: async (sessionId, message) => {
				const session = agentSessions.get(sessionId);
				if (!session) {
					throw new Error(`Session not in service cache: ${sessionId}`);
				}
				// Ensure the SDK query is running before enqueuing. After daemon
				// restart, restored sessions are in cache but haven't started
				// their query yet (lazy start to avoid startup timeout).
				await session.ensureQueryStarted();
				// Pre-persist to DB with 'queued' status before enqueuing,
				// exactly like the normal UI send flow. This ensures
				// acknowledgePersistedUserMessage() finds the message by UUID
				// and treats it as a normal user message (not synthetic).
				const messageId = generateUUID();
				const sdkUserMessage: SDKUserMessage = {
					type: 'user' as const,
					uuid: messageId as UUID,
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: 'user' as const,
						content: [{ type: 'text' as const, text: message }],
					},
				};
				ctx.db.saveUserMessage(sessionId, sdkUserMessage, 'queued');
				await session.messageQueue.enqueueWithId(messageId, message);
			},
			hasSession: (sessionId) => {
				return agentSessions.has(sessionId);
			},
			answerQuestion: async (sessionId, answer) => {
				const session = agentSessions.get(sessionId);
				if (!session) return false;
				const state = session.getProcessingState();
				if (state.status !== 'waiting_for_input') return false;
				const { toolUseId, questions } = state.pendingQuestion;
				// Answer all questions with the leader's text as customText
				const responses = questions.map((_, i) => ({
					questionIndex: i,
					selectedLabels: [] as string[],
					customText: answer,
				}));
				await session.handleQuestionResponse(toolUseId, responses);
				return true;
			},
			restoreSession: async (sessionId) => {
				// Idempotent: already in cache
				if (agentSessions.has(sessionId)) return true;

				const session = AgentSession.restore(
					sessionId,
					ctx.db,
					ctx.messageHub,
					ctx.daemonHub,
					ctx.getApiKey
				);
				if (!session) return false;

				agentSessions.set(sessionId, session);
				// Don't call startStreamingQuery() here — the SDK query will be
				// started lazily when injectMessage() is called. Eagerly starting
				// without a queued message causes a 15s startup timeout because the
				// SDK waits for user input that never arrives.
				return true;
			},
			setSessionMcpServers: (sessionId, mcpServers) => {
				const session = agentSessions.get(sessionId);
				if (!session) return false;
				session.setRuntimeMcpServers(
					mcpServers as Record<string, import('@neokai/shared').McpServerConfig>
				);
				return true;
			},
			createWorktree: async (basePath, sessionId, branchName) => {
				try {
					const result = await worktreeManager.createWorktree({
						sessionId,
						repoPath: basePath,
						branchName,
					});
					return result?.worktreePath ?? null;
				} catch (error) {
					log.warn(`Failed to create worktree for ${sessionId}:`, error);
					return null;
				}
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

		const workspacePath = room.defaultPath ?? this.ctx.defaultWorkspacePath;

		const roomConfig = (room.config ?? {}) as Record<string, unknown>;
		const rawRounds = roomConfig.maxReviewRounds;
		const maxReviewRounds =
			typeof rawRounds === 'number' && rawRounds >= 1
				? Math.min(Math.floor(rawRounds), MAX_REVIEW_ROUNDS_LIMIT)
				: undefined;
		const rawGroups = roomConfig.maxConcurrentGroups;
		const maxConcurrentGroups =
			typeof rawGroups === 'number' && rawGroups >= 1
				? Math.min(Math.floor(rawGroups), MAX_CONCURRENT_GROUPS_LIMIT)
				: undefined;

		const runtime = new RoomRuntime({
			room,
			groupRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath,
			model: this.ctx.defaultModel,
			maxFeedbackIterations: maxReviewRounds,
			maxConcurrentGroups,
			getWorkerMessages: (sessionId, afterMessageId) =>
				sdkMessageRepo.getAssistantMessagesSince(sessionId, afterMessageId),
			daemonHub: this.ctx.daemonHub,
			messageHub: this.ctx.messageHub,
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
			daemonHub: this.ctx.daemonHub,
			runtimeService: this,
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

		// room.updated — refresh the runtime's room reference so lifecycle hooks see latest config
		const unsubRoomUpdated = this.ctx.daemonHub.on(
			'room.updated',
			(event) => {
				const runtime = this.runtimes.get(event.roomId);
				if (runtime) {
					const room = this.ctx.roomManager.getRoom(event.roomId);
					if (room) {
						runtime.updateRoom(room);
					}
				}
			},
			{ sessionId: 'global' }
		);
		this.unsubscribers.push(unsubRoomUpdated);

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
		const sessionFactory = this.createSessionFactory();

		const checker: SessionStateChecker = {
			sessionExists: (sessionId) => this.ctx.db.getSession(sessionId) !== null,
			// Assume not terminal after restart — active groups stuck post-restart
			// can be cancelled via the cancel_task Room Agent tool.
			isTerminalState: () => false,
			isLive: (sessionId) => this.agentSessions.has(sessionId),
			restoreSession: (sessionId) => sessionFactory.restoreSession(sessionId),
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
			if (result.recoveredGroups > 0) {
				log.info(
					`Room ${roomId}: recovered ${result.recoveredGroups} groups, ` +
						`failed ${result.failedGroups}, restored ${result.restoredSessions} sessions, ` +
						`reattached ${result.reattachedObservers} observers`
				);
			}

			// Restore MCP servers and inject continuation messages for restored sessions.
			// MCP servers are runtime-only (non-serializable) and lost on restart.
			// Must be restored BEFORE continuation messages so the SDK query starts
			// with the correct tools available (e.g. planner needs create_task).
			if (result.restoredSessions > 0) {
				const activeGroups = groupRepo.getActiveGroups(roomId);
				for (const group of activeGroups) {
					try {
						// Restore MCP servers (planner-tools, leader-agent-tools)
						await runtime.restoreMcpServersForGroup(group);

						// Inject continuation message to resume work
						if (group.state === 'awaiting_worker') {
							await sessionFactory.injectMessage(
								group.workerSessionId,
								'The system was restarted. Continue working on the task.'
							);
						} else if (group.state === 'awaiting_leader') {
							await sessionFactory.injectMessage(
								group.leaderSessionId,
								'The system was restarted. Continue reviewing from where you left off.'
							);
						}
						// awaiting_human: no message needed — human will provide one
					} catch (error) {
						log.error(
							`Failed to restore/inject continuation for group ${group.id} (${group.state}):`,
							error
						);
					}
				}
			}
		} catch (error) {
			log.error(`Failed to recover runtime for room ${roomId}:`, error);
		}
	}
}
