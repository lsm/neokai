/**
 * WorkerManager - Direct worker session creation and lifecycle
 *
 * PHASE 4-5: Replaces SessionPairManager with simpler worker-only approach.
 * Room agents (both room:chat and room:self) create workers directly; workers signal completion back.
 *
 * This unified approach ensures:
 * - room:chat users can manually spawn workers via room agent tools
 * - room:self agents automatically spawn workers for task execution
 * - Both modes use the same WorkerManager interface
 * - Workers have direct access to worker_complete_task and worker_request_review tools
 *
 * Key responsibilities:
 * - Spawn worker sessions for tasks
 * - Create worker-tools MCP server for each worker
 * - Track worker session status
 * - Handle task completion events
 * - Support both room:chat and room:self spawning
 *
 * CRITICAL FIXES APPLIED (v1.0):
 * - FIX 2: Uses mode-agnostic roomSessionId (supports both room:chat and room:self)
 * - FIX 3: Tracks session_id for direct agent session lookup
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	WorkerCompleteTaskParams,
	WorkerSession,
	WorkerStatus,
	McpServerConfig,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/index';
import { WorkerSessionRepository } from '../../storage/repositories/worker-session-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { createWorkerToolsMcpServer, type WorkerToolsConfig } from '../agent/worker-tools';
import type { RoomManager } from './room-manager';
import { Logger } from '../logger';

const log = new Logger('worker-manager');

/**
 * Configuration for spawning a worker
 */
export interface SpawnWorkerConfig {
	/** ID of the room */
	roomId: string;
	/** Room agent session ID (mode-agnostic) - FIX 2 */
	roomSessionId: string;
	/** Room agent type - FIX 2 */
	roomSessionType: 'room_chat' | 'room_self';
	/** Task ID to execute */
	taskId: string;
	/** Task title */
	taskTitle: string;
	/** Task description */
	taskDescription?: string;
	/** Workspace path */
	workspacePath?: string;
	/** Model to use */
	model?: string;
}

export class WorkerManager {
	private workerSessionRepo: WorkerSessionRepository;
	private taskRepo: TaskRepository;
	/** Worker tools MCP servers indexed by worker session ID */
	private workerTools: Map<string, ReturnType<typeof createWorkerToolsMcpServer>> = new Map();

	constructor(
		private db: Database | BunDatabase,
		private daemonHub: DaemonHub,
		private sessionLifecycle: import('../session/session-lifecycle').SessionLifecycle,
		private roomManager: RoomManager
	) {
		// Handle both Database wrapper and raw BunDatabase
		const rawDb = 'getDatabase' in db ? db.getDatabase() : db;
		this.workerSessionRepo = new WorkerSessionRepository(rawDb);
		this.taskRepo = new TaskRepository(rawDb);
	}

	/**
	 * Spawn a new worker for a task
	 *
	 * Creates:
	 * 1. A worker session with full Claude Code capabilities
	 * 2. Worker tools MCP server for completion signaling
	 * 3. Worker session tracking record
	 *
	 * Returns the worker session ID
	 */
	async spawnWorker(config: SpawnWorkerConfig): Promise<string> {
		const {
			roomId,
			roomSessionId,
			roomSessionType,
			taskId,
			taskTitle,
			taskDescription,
			workspacePath,
			model,
		} = config;

		// Validate room exists and get room configuration
		const room = this.roomManager.getRoom(roomId);
		if (!room) {
			throw new Error(`Room not found: ${roomId}`);
		}

		// Determine workspace path and model
		const workerPath =
			workspacePath ?? room.defaultPath ?? room.allowedPaths[0]?.path ?? process.cwd();
		const workerModel = model ?? room.defaultModel;

		// Create WorkerSession via SessionLifecycle
		const workerSessionId = await this.sessionLifecycle.create({
			workspacePath: workerPath,
			title: `Worker: ${taskTitle}`,
			config: workerModel ? { model: workerModel } : undefined,
			roomId,
			sessionType: 'worker',
			currentTaskId: taskId,
			parentSessionId: roomSessionId,
		});

		// Track worker session FIRST (before assigning to room)
		// This ensures events can always find the worker via getWorkerBySessionId()
		this.workerSessionRepo.createWorkerSession({
			id: generateUUID(),
			roomId,
			roomSessionId, // FIX 2: Mode-agnostic
			sessionId: workerSessionId, // FIX 3: Track actual session ID
			roomSessionType, // FIX 2: Discriminator
			taskId,
			status: 'starting',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		// Assign to room (after tracking record is created)
		this.roomManager.assignSession(roomId, workerSessionId);

		// Create worker tools MCP server
		const workerToolsMcp = this.createWorkerToolsMcp(workerSessionId, taskId);
		this.workerTools.set(workerSessionId, workerToolsMcp);

		// Get agent session and inject tools
		const agentSession = this.sessionLifecycle.getAgentSession(workerSessionId);
		if (agentSession) {
			// Inject worker tools into the worker session's runtime config
			agentSession.session.config.mcpServers = {
				...agentSession.session.config.mcpServers,
				'worker-tools': workerToolsMcp as unknown as McpServerConfig,
			};

			// Start streaming query
			await agentSession.startStreamingQuery();

			// Send initial task prompt
			const workerPrompt = this.buildWorkerPrompt(taskTitle, taskDescription);
			await agentSession.messageQueue.enqueue(workerPrompt, true);
		}

		// Emit event
		await this.daemonHub.emit('worker.started', {
			sessionId: workerSessionId,
			roomId,
			taskId,
		});

		return workerSessionId;
	}

	/**
	 * Get worker session tracking record by task ID
	 */
	getWorkerByTask(taskId: string): WorkerSession | null {
		return this.workerSessionRepo.getWorkerByTask(taskId);
	}

	/**
	 * Get worker session by agent session ID
	 */
	getWorkerBySessionId(sessionId: string): WorkerSession | null {
		return this.workerSessionRepo.getWorkerBySessionId(sessionId);
	}

	/**
	 * Get all worker sessions for a room
	 */
	getWorkersByRoom(roomId: string): WorkerSession[] {
		return this.workerSessionRepo.getWorkersByRoom(roomId);
	}

	/**
	 * Get all worker sessions for a specific room agent
	 */
	getWorkersByRoomSession(roomSessionId: string): WorkerSession[] {
		return this.workerSessionRepo.getWorkersByRoomSession(roomSessionId);
	}

	/**
	 * Update worker status
	 */
	updateWorkerStatus(workerSessionId: string, status: WorkerStatus): void {
		this.workerSessionRepo.updateWorkerStatusBySessionId(workerSessionId, status);
	}

	/**
	 * Complete a worker session
	 */
	completeWorker(workerSessionId: string): void {
		this.workerSessionRepo.completeWorkerSessionBySessionId(workerSessionId);
		// Clean up worker tools map to prevent memory leak
		this.workerTools.delete(workerSessionId);
	}

	/**
	 * Terminate all workers for a room (used during room deletion)
	 *
	 * This ensures running worker sessions are properly stopped before
	 * the room and its data are deleted from the database.
	 *
	 * @param roomId - The room ID to terminate workers for
	 */
	async terminateWorkersForRoom(roomId: string): Promise<void> {
		const workers = this.getWorkersByRoom(roomId);

		for (const worker of workers) {
			// Skip already completed/failed workers
			if (worker.status === 'completed' || worker.status === 'failed') {
				continue;
			}

			// Get the agent session and cleanup (stops SDK query)
			const agentSession = this.sessionLifecycle.getAgentSession(worker.sessionId);
			if (agentSession) {
				try {
					await agentSession.cleanup();
				} catch (error) {
					// Log but continue - we still need to mark as failed
					log.error(`Error cleaning up worker ${worker.sessionId}:`, error);
				}
			}

			// Clean up worker tools
			this.workerTools.delete(worker.sessionId);

			// Mark worker as failed in database
			this.updateWorkerStatus(worker.sessionId, 'failed');
		}
	}

	/**
	 * Get the worker tools MCP server for a worker session
	 */
	getWorkerTools(sessionId: string): ReturnType<typeof createWorkerToolsMcpServer> | undefined {
		return this.workerTools.get(sessionId);
	}

	/**
	 * Mark a worker as failed and emit the failure event
	 *
	 * This should be called when:
	 * - The worker's SDK session crashes
	 * - The worker encounters an unrecoverable error
	 * - The worker times out
	 *
	 * @param workerSessionId - The worker's session ID
	 * @param error - The error message describing the failure
	 */
	async markWorkerFailed(workerSessionId: string, error: string): Promise<void> {
		const worker = this.getWorkerBySessionId(workerSessionId);
		if (!worker) {
			return;
		}

		// Update worker status
		this.updateWorkerStatus(workerSessionId, 'failed');

		// Update task status
		this.taskRepo.updateTask(worker.taskId, {
			status: 'failed',
			error,
		});

		// Remove from active worker tools
		this.workerTools.delete(workerSessionId);

		// Emit failure event for room agents to handle
		await this.daemonHub.emit('worker.failed', {
			sessionId: workerSessionId,
			taskId: worker.taskId,
			error,
		});
	}

	/**
	 * Build the initial prompt for a worker session
	 */
	private buildWorkerPrompt(taskTitle: string, taskDescription?: string): string {
		const parts: string[] = [];

		parts.push('You have been assigned the following task:\n\n');
		parts.push(`**${taskTitle}**\n\n`);

		if (taskDescription) {
			parts.push(`${taskDescription}\n\n`);
		}

		parts.push('Please complete this task using the available tools.\n\n');
		parts.push('When you have finished:\n');
		parts.push('1. Call `worker_complete_task` with a summary of what you accomplished\n');
		parts.push(
			'2. If you need human review or approval at any point, call `worker_request_review`\n\n'
		);
		parts.push('Available worker-specific tools:\n');
		parts.push('- `worker_complete_task`: Mark your task as complete\n');
		parts.push('- `worker_request_review`: Request human review before proceeding');

		return parts.join('');
	}

	/**
	 * Create worker tools MCP server for a specific worker session
	 */
	private createWorkerToolsMcp(workerSessionId: string, taskId: string) {
		const config: WorkerToolsConfig = {
			sessionId: workerSessionId,
			taskId,
			onCompleteTask: async (params: WorkerCompleteTaskParams) => {
				// Update task status
				this.taskRepo.updateTask(params.taskId, {
					status: 'completed',
					progress: 100,
					result: params.summary,
				});

				// Complete worker session
				this.completeWorker(workerSessionId);

				// Emit event for room agents to handle
				await this.daemonHub.emit('worker.task_completed', {
					sessionId: workerSessionId,
					taskId: params.taskId,
					summary: params.summary,
					filesChanged: params.filesChanged,
					nextSteps: params.nextSteps,
				});
			},
			onRequestReview: async (reason: string) => {
				// Update worker status
				this.updateWorkerStatus(workerSessionId, 'waiting_for_review');

				// Emit event for room agents to handle
				await this.daemonHub.emit('worker.review_requested', {
					sessionId: workerSessionId,
					taskId,
					reason,
				});
			},
		};

		return createWorkerToolsMcpServer(config);
	}
}
