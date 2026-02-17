/**
 * SessionPairManager - Manages manager-worker session pairs
 *
 * Handles:
 * - Creating paired sessions (Manager + Worker)
 * - Pair lifecycle management
 * - Task assignment to pairs
 * - Session linking and coordination
 * - Manager tools MCP server for task completion
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import { SessionPairRepository } from '../../storage/repositories/session-pair-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import {
	createManagerToolsMcpServer,
	type ManagerCompleteTaskParams,
} from '../agent/manager-tools';
import type { DaemonHub } from '../daemon-hub';
import type {
	SessionPair,
	SessionPairStatus,
	CreateSessionPairParams,
	NeoTask,
} from '@neokai/shared';
import type { McpSdkServerConfigWithInstance } from '@neokai/shared/sdk';
import type { SessionLifecycle } from '../session/session-lifecycle';
import type { RoomManager } from './room-manager';

export class SessionPairManager {
	private sessionPairRepo: SessionPairRepository;
	private taskRepo: TaskRepository;
	/** Manager tools MCP servers indexed by manager session ID */
	private managerTools: Map<string, McpSdkServerConfigWithInstance> = new Map();

	constructor(
		private db: BunDatabase,
		private sessionLifecycle: SessionLifecycle,
		private roomManager: RoomManager,
		private daemonHub: DaemonHub
	) {
		this.sessionPairRepo = new SessionPairRepository(db);
		this.taskRepo = new TaskRepository(db);
	}

	/**
	 * Create a new session pair with associated task
	 *
	 * Creates:
	 * 1. A room-level task for tracking
	 * 2. Worker session (executes work)
	 * 3. Manager session (coordinates and reviews)
	 * 4. SessionPair record linking them together
	 */
	async createPair(params: CreateSessionPairParams): Promise<{ pair: SessionPair; task: NeoTask }> {
		// 1. Validate room exists
		const room = this.roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// 2. Create room-level task
		const task = this.taskRepo.createTask({
			roomId: params.roomId,
			title: params.taskTitle,
			description: params.taskDescription ?? '',
		});

		// 3. Determine workspace path and model
		const workspacePath = params.workspacePath ?? room.defaultPath ?? room.allowedPaths[0];
		if (!workspacePath) {
			throw new Error('No workspace path available for session pair');
		}
		const model = params.model ?? room.defaultModel;

		// 4. Create WorkerSession first
		const workerSessionId = await this.sessionLifecycle.create({
			workspacePath,
			title: `Worker: ${params.taskTitle}`,
			config: model ? { model } : undefined,
			roomId: params.roomId,
			sessionType: 'worker',
			currentTaskId: task.id,
			parentSessionId: params.roomSessionId,
		});

		// Assign to room
		this.roomManager.assignSession(params.roomId, workerSessionId);

		// 5. Create ManagerSession linked to Worker
		const managerSessionId = await this.sessionLifecycle.create({
			workspacePath,
			title: `Manager: ${params.taskTitle}`,
			config: model ? { model } : undefined,
			roomId: params.roomId,
			sessionType: 'manager',
			pairedSessionId: workerSessionId,
			currentTaskId: task.id,
			parentSessionId: params.roomSessionId,
		});

		// Assign to room
		this.roomManager.assignSession(params.roomId, managerSessionId);

		// 6. Update WorkerSession with pairedSessionId pointing to Manager
		await this.sessionLifecycle.update(workerSessionId, {
			metadata: {
				pairedSessionId: managerSessionId,
			},
		} as any); // eslint-disable-line @typescript-eslint/no-explicit-any

		// 7. Create SessionPair record
		const pair = this.sessionPairRepo.createPair({
			id: generateUUID(),
			roomId: params.roomId,
			roomSessionId: params.roomSessionId,
			managerSessionId,
			workerSessionId,
			currentTaskId: task.id,
		});

		// 8. Create manager tools MCP server for the manager session
		const managerToolsMcp = createManagerToolsMcpServer({
			sessionId: managerSessionId,
			onCompleteTask: async (completeParams: ManagerCompleteTaskParams) => {
				// Update task status
				this.taskRepo.updateTask(completeParams.taskId, {
					status: 'completed',
					progress: 100,
					result: completeParams.summary,
				});

				// Update pair status
				this.sessionPairRepo.updatePairStatus(pair.id, 'completed');

				// Emit event for RoomAgent/SessionBridge to handle
				await this.daemonHub.emit('pair.task_completed', {
					sessionId: managerSessionId,
					pairId: pair.id,
					taskId: completeParams.taskId,
					summary: completeParams.summary,
					filesChanged: completeParams.filesChanged,
					nextSteps: completeParams.nextSteps,
				});
			},
		});
		this.managerTools.set(managerSessionId, managerToolsMcp);

		return { pair, task };
	}

	/**
	 * Get a session pair by ID
	 */
	getPair(id: string): SessionPair | null {
		return this.sessionPairRepo.getPair(id);
	}

	/**
	 * Get all session pairs for a room
	 */
	getPairsByRoom(roomId: string): SessionPair[] {
		return this.sessionPairRepo.getPairsByRoom(roomId);
	}

	/**
	 * Get a session pair by either manager or worker session ID
	 */
	getPairBySession(sessionId: string): SessionPair | null {
		return this.sessionPairRepo.getPairBySession(sessionId);
	}

	/**
	 * Update the status of a session pair
	 */
	updatePairStatus(id: string, status: SessionPairStatus): SessionPair | null {
		return this.sessionPairRepo.updatePairStatus(id, status);
	}

	/**
	 * Archive a session pair
	 *
	 * Sets status to 'completed' and optionally archives associated sessions.
	 */
	async archivePair(id: string): Promise<boolean> {
		const pair = this.sessionPairRepo.getPair(id);
		if (!pair) return false;

		// Update status to completed
		this.sessionPairRepo.updatePairStatus(id, 'completed');

		// Optionally archive the sessions
		// This could be expanded based on requirements

		return true;
	}

	/**
	 * Delete a session pair
	 *
	 * Removes the pair record. Associated sessions are not deleted.
	 */
	deletePair(id: string): boolean {
		return this.sessionPairRepo.deletePair(id);
	}

	/**
	 * Get the manager tools MCP server for a manager session
	 *
	 * Returns the MCP server instance that provides manager tools (manager_complete_task, etc.)
	 * for the given manager session ID.
	 */
	getManagerTools(sessionId: string): McpSdkServerConfigWithInstance | undefined {
		return this.managerTools.get(sessionId);
	}
}
