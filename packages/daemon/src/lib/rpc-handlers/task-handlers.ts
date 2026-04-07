/**
 * Task RPC Handlers
 *
 * RPC handlers for Neo task operations:
 * - task.create - Create task in room
 * - task.list - List tasks in room
 * - task.get - Get task details
 * - task.fail - Fail a task (used by tests to simulate failure)
 * - task.cancel - Cancel a task (human-initiated cancellation)
 * - task.interruptSession - Interrupt current agent session(s) without changing task status
 * - task.setStatus - Set task status with validation (human-initiated status change)
 * - task.reject - Reject a task review (human-initiated rejection with feedback)
 * - task.getGroup - Get session group for a task
 * - task.getGroupMessages - Get messages for a session group
 * - task.sendHumanMessage - Send a human message to the active agent in a task group
 * - task.updateDraft - Persist human input draft for a task (server-side, debounced by client)
 * - task.group.create - (non-production) Create a synthetic session group for a task
 * - task.group.addMessage - (non-production) Insert a synthetic canonical timeline row
 * - inbox.reviewTasks - Get all review-status tasks across all active rooms
 */

import type { MessageHub, TaskPriority, TaskStatus, TaskSummary } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { ReactiveDatabase } from '../../storage/reactive-database';
import type { RoomManager } from '../room/managers/room-manager';
import type { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import type { SessionManager } from '../session-manager';
import { TaskManager, VALID_STATUS_TRANSITIONS } from '../room/managers/task-manager';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { resolveTaskId } from '../id-resolution';
import { toTaskSummary } from '../task-utils';
import { SessionGroupRepository } from '../room/state/session-group-repository';
import { routeHumanMessageToGroup } from '../room/runtime/human-message-routing';
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
import { Logger } from '../logger';

const log = new Logger('task-handlers');

export type TaskManagerLike = Pick<
	TaskManager,
	| 'createTask'
	| 'getTask'
	| 'listTasks'
	| 'failTask'
	| 'cancelTask'
	| 'setTaskStatus'
	| 'archiveTask'
	| 'updateTaskStatus'
>;

export type TaskManagerFactory = (db: Database, roomId: string) => TaskManagerLike;

export function setupTaskHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	db: Database,
	reactiveDb: ReactiveDatabase,
	taskManagerFactory: TaskManagerFactory = (d, roomId) =>
		new TaskManager(d.getDatabase(), roomId, reactiveDb, d.getShortIdAllocator()),
	runtimeService?: RoomRuntimeService,
	sessionManager?: SessionManager
): void {
	const makeGroupRepo = () => new SessionGroupRepository(db.getDatabase(), reactiveDb);
	const makeTaskRepo = () => new TaskRepository(db.getDatabase(), reactiveDb);

	/**
	 * Emit room.overview event to notify UI clients of full room state
	 */
	const emitRoomOverview = (roomId: string) => {
		const overview = roomManager.getRoomOverview(roomId);
		if (overview) {
			daemonHub
				.emit('room.overview', {
					sessionId: `room:${roomId}`,
					room: overview.room,
					sessions: overview.sessions,
				})
				.catch((error) => {
					log.warn(`Failed to emit room.overview for room ${roomId}:`, error);
				});
		}
	};

	// task.create - Create task in room
	messageHub.onRequest('task.create', async (data) => {
		const params = data as {
			roomId: string;
			title: string;
			description: string;
			priority?: TaskPriority;
			dependsOn?: string[];
			status?: TaskStatus;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.title) {
			throw new Error('Task title is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.createTask({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
			dependsOn: params.dependsOn,
			status: params.status,
		});

		return { task };
	});

	// task.list - List tasks in room
	messageHub.onRequest('task.list', async (data) => {
		const params = data as {
			roomId: string;
			status?: TaskStatus;
			priority?: TaskPriority;
			includeArchived?: boolean;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const tasks = await taskManager.listTasks({
			status: params.status,
			priority: params.priority,
			includeArchived: params.includeArchived,
		});

		return { tasks };
	});

	// task.get - Get task details
	messageHub.onRequest('task.get', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);

		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		return { task };
	});

	// task.updateDraft - Persist human input draft for a task (server-side)
	messageHub.onRequest('task.updateDraft', async (data) => {
		const params = data as { roomId: string; taskId: string; draft: string | null };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		if (typeof params.draft === 'string' && params.draft.length > 200_000) {
			throw new Error('Draft is too long (max 200,000 characters)');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());

		// Verify the task belongs to this room
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Normalize: treat empty/whitespace strings as null to keep storage consistent
		// with the hook's restore check (`if (draft)` treats '' as falsy)
		const draft = typeof params.draft === 'string' ? params.draft.trim() || null : null;

		// Update input_draft directly via repository (lightweight, no status side effects)
		const taskRepo = makeTaskRepo();
		taskRepo.updateTask(taskId, { inputDraft: draft });

		return { success: true };
	});

	// task.fail - Fail a task
	messageHub.onRequest('task.fail', async (data) => {
		const params = data as { roomId: string; taskId: string; error: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.failTask(taskId, params.error ?? '');

		return { task };
	});

	// task.cancel - Cancel a task (human-initiated)
	messageHub.onRequest('task.cancel', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Only allow cancelling pending, in_progress, or review tasks
		if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'review') {
			throw new Error(`Task cannot be cancelled (current status: ${task.status})`);
		}

		// If there's an active group with runtime, cancel the running agents first
		if (runtimeService) {
			const runtime = runtimeService.getRuntime(params.roomId);
			if (runtime) {
				const result = await runtime.cancelTask(taskId);
				if (!result.success) {
					throw new Error(
						`Failed to cancel task ${taskId} — runtime cancellation was unsuccessful`
					);
				}
				const updatedTask = await taskManager.getTask(taskId);
				if (updatedTask) {
					// TODO: remove once session LiveQuery covers list
					emitRoomOverview(params.roomId);
					return { task: updatedTask };
				}
			}
		}

		// No active group - just mark the task as cancelled
		const cancelledTask = await taskManager.cancelTask(taskId);

		return { task: cancelledTask };
	});

	// task.interruptSession - Interrupt current agent session(s) without changing task status.
	// Stops LLM generation mid-stream while keeping the task alive. The user can immediately
	// type new instructions and the session will process them.
	messageHub.onRequest('task.interruptSession', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Only allow interrupting tasks with active agent sessions
		if (task.status !== 'in_progress' && task.status !== 'review') {
			throw new Error(
				`Task cannot be interrupted (current status: ${task.status}). Only in_progress or review tasks can be interrupted.`
			);
		}

		if (!runtimeService) {
			throw new Error('Runtime service is required for task.interruptSession');
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		const result = await runtime.interruptTaskSession(taskId);
		if (!result.success) {
			throw new Error(`Failed to interrupt task session for ${taskId}`);
		}

		return { success: true };
	});

	// task.archive - Archive a task (cleanup worktree, hide from UI)
	messageHub.onRequest('task.archive', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Validate task is in a terminal state before archiving
		const TERMINAL_STATES: TaskStatus[] = ['completed', 'needs_attention', 'cancelled'];
		if (!TERMINAL_STATES.includes(task.status)) {
			throw new Error(
				`Cannot archive task in '${task.status}' state. Only tasks in terminal states (completed, needs_attention, cancelled) can be archived.`
			);
		}

		// If there's a runtime, delegate to it: it handles worktree cleanup AND sets archivedAt.
		// Without a runtime, we still must set archivedAt so the task is hidden from the UI.
		const runtime = runtimeService?.getRuntime(params.roomId);
		if (runtime) {
			await runtime.archiveTaskGroup(taskId);
		} else {
			// No runtime — set archivedAt directly. Worktree cleanup (if any) is skipped;
			// orphaned worktrees must be reclaimed manually via the worktree.cleanup RPC.
			await taskManager.archiveTask(taskId);
		}

		const archivedTask = await taskManager.getTask(taskId);

		log.info(`Task ${taskId} archived in room ${params.roomId}`);
		return { task: archivedTask };
	});

	// task.setStatus - Set task status with validation (human-initiated)
	messageHub.onRequest('task.setStatus', async (data) => {
		const params = data as {
			roomId: string;
			taskId: string;
			status: TaskStatus;
			result?: string;
			error?: string;
			mode?: 'manual' | 'runtime';
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.status) {
			throw new Error('Status is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Validate status transition for runtime mode. This must happen here (not just in the
		// manager) because the cancel and archive paths below use early returns that bypass
		// setTaskStatus/archiveTask validation. Manual mode bypasses this check.
		if (params.mode !== 'manual') {
			const allowedTransitions = VALID_STATUS_TRANSITIONS[task.status];
			if (!allowedTransitions.includes(params.status)) {
				throw new Error(
					`Invalid status transition from '${task.status}' to '${params.status}'. ` +
						`Allowed: ${allowedTransitions.join(', ') || 'none'}`
				);
			}
		}

		// Archiving: delegate entirely to archiveTaskGroup (terminates sessions + cleans worktree)
		// or archiveTask (no runtime — sets archivedAt directly). Early return skips generic path.
		// Only applies to transitioning TO 'archived' (unarchiving is handled by the generic path below).
		if (params.status === 'archived') {
			const runtime = runtimeService?.getRuntime(params.roomId);
			const modeOpts = params.mode ? { mode: params.mode } : undefined;
			if (runtime) {
				await runtime.archiveTaskGroup(taskId, modeOpts);
			} else {
				await taskManager.archiveTask(taskId, modeOpts);
			}

			const archivedTask = await taskManager.getTask(taskId);
			return { task: archivedTask };
		}

		// If there's an active group with runtime, terminate it on terminal transitions.
		if (runtimeService) {
			const runtime = runtimeService.getRuntime(params.roomId);
			if (runtime) {
				const isTerminalStatus =
					params.status === 'completed' ||
					params.status === 'needs_attention' ||
					params.status === 'cancelled';
				if (isTerminalStatus) {
					if (params.status === 'cancelled') {
						const cancelResult = await runtime.cancelTask(taskId);
						if (!cancelResult.success) {
							throw new Error(
								`Failed to cancel task ${taskId} — runtime cancellation was unsuccessful`
							);
						}
						const cancelledTask = await taskManager.getTask(taskId);
						if (!cancelledTask) {
							throw new Error(`Task not found: ${taskId}`);
						}
						// TODO: remove once session LiveQuery covers list
						emitRoomOverview(params.roomId);
						return { task: cancelledTask };
					}

					const terminated = await runtime.terminateTaskGroup(taskId);
					if (!terminated) {
						throw new Error(
							`Failed to terminate task group for task ${taskId} — group may have been modified concurrently`
						);
					}
				}
			}
		}

		// Handle restart: reset cancelled/needs_attention group so runtime picks it up fresh.
		// completed → in_progress uses lightweight revival (group preserved, no full wipe).
		if (
			task.status === 'needs_attention' ||
			task.status === 'cancelled' ||
			(params.mode === 'manual' && task.status === 'archived')
		) {
			if (params.status === 'pending' || params.status === 'in_progress') {
				const groupRepo = makeGroupRepo();
				const group = groupRepo.getGroupByTaskId(taskId);
				if (group) {
					const reset = groupRepo.resetGroupForRestart(group.id);
					if (!reset) {
						throw new Error(
							`Failed to reset group for task ${taskId} — group may have been modified concurrently`
						);
					}
				}
			}
		}

		// Clear group rate limit when resuming from a rate/usage limited state.
		// This is a separate block (not inside the restart block above) because
		// rate_limited/usage_limited tasks are NOT covered by the restart block.
		// Note: pending is only reachable from these statuses in manual mode
		// (VALID_STATUS_TRANSITIONS only allows in_progress in runtime mode).
		if (
			(task.status === 'usage_limited' || task.status === 'rate_limited') &&
			(params.status === 'in_progress' || params.status === 'pending')
		) {
			const runtime = runtimeService?.getRuntime(params.roomId);
			if (runtime) {
				await runtime.clearGroupRateLimit(taskId);
			}
		}

		// Apply status change
		const updatedTask = await taskManager.setTaskStatus(taskId, params.status, {
			result: params.result,
			error: params.error,
			mode: params.mode,
		});

		return { task: updatedTask };
	});

	// task.reject - Reject a task review with feedback
	messageHub.onRequest('task.reject', async (data) => {
		const params = data as { roomId: string; taskId: string; feedback: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.feedback || !params.feedback.trim()) {
			throw new Error('Feedback is required for rejection');
		}
		if (params.feedback.length > 10_000) {
			throw new Error('Feedback is too long (max 10,000 characters)');
		}
		if (!runtimeService) {
			throw new Error('Runtime service is required for task.reject');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.status !== 'review') {
			throw new Error(`Task is not in review status (current: ${task.status})`);
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		const groupRepo = makeGroupRepo();
		const group = groupRepo.getGroupByTaskId(taskId);
		if (!group) {
			throw new Error('No active session group for this task');
		}

		// Resume via runtime so review parking flags and task status are updated consistently.
		const message = `[Human Rejection]\n\n${params.feedback.trim()}`;
		const resumed = await runtime.resumeWorkerFromHuman(taskId, message, {
			approved: false,
		});
		if (!resumed) {
			throw new Error('Failed to reject task — task may not be awaiting review');
		}

		log.info(`Task ${taskId} rejected by human in room ${params.roomId}`);
		return { success: true };
	});

	// task.getGroup - Get the active session group (Craft + Lead sessions) for a task.
	// Also fetches worker and leader session info in parallel to avoid 2 additional round-trips.
	messageHub.onRequest('task.getGroup', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const groupRepo = makeGroupRepo();
		const group = groupRepo.getGroupByTaskId(taskId);

		if (!group) {
			return { group: null };
		}

		// Fetch worker and leader session info in parallel and bundle with the group response.
		// This eliminates the 2 extra session.get round-trips the client used to make after
		// receiving the group. Sessions are almost always in the in-memory cache so this
		// adds negligible latency. Best-effort: null is returned on any lookup failure.
		const [workerSession, leaderSession] = await Promise.all([
			sessionManager
				?.getSessionAsync(group.workerSessionId)
				.then((s) => s?.getSessionData() ?? null)
				.catch(() => null) ?? Promise.resolve(null),
			sessionManager
				?.getSessionAsync(group.leaderSessionId)
				.then((s) => s?.getSessionData() ?? null)
				.catch(() => null) ?? Promise.resolve(null),
		]);

		return {
			group: {
				id: group.id,
				taskId: group.taskId,
				workerSessionId: group.workerSessionId,
				leaderSessionId: group.leaderSessionId,
				workerRole: group.workerRole,
				feedbackIteration: group.feedbackIteration,
				submittedForReview: group.submittedForReview,
				approved: group.approved,
				createdAt: group.createdAt,
				completedAt: group.completedAt,
				workerSession,
				leaderSession,
			},
		};
	});

	// task.getGroupMessages - Get a unified timeline for a session group
	//
	// Pagination modes:
	//  1. Initial load (no cursor): Returns the NEWEST `limit` messages
	//  2. Load older (before cursor): Returns messages older than the cursor
	//  3. Load newer (after cursor): Returns messages newer than the cursor (for real-time updates)
	//
	// The cursor format is: `${timestamp_padded}|${sourceKey}`
	messageHub.onRequest('task.getGroupMessages', async (data) => {
		const params = data as {
			groupId: string;
			cursor?: string;
			before?: string; // Cursor to load older messages (messages with cursor < before)
			limit?: number;
		};

		if (!params.groupId) {
			throw new Error('Group ID is required');
		}

		const groupRepo = makeGroupRepo();
		const group = groupRepo.getGroup(params.groupId);
		if (!group) {
			return {
				messages: [],
				hasMore: false,
				nextCursor: null,
				hasOlder: false,
				oldestCursor: null,
			};
		}

		const sdkRepo = new SDKMessageRepository(db.getDatabase());

		// Validate and normalize limit parameter
		const limit = Math.max(1, Math.min(params.limit ?? 50, 200));

		// Parse 'before' cursor to extract timestamp for DB-level filtering
		// Cursor format: `${timestamp_padded}|${sourceKey}`
		let beforeTimestamp: number | undefined;
		if (params.before) {
			const timestampPart = params.before.split('|')[0];
			const parsed = parseInt(timestampPart, 10);
			if (!Number.isNaN(parsed)) {
				beforeTimestamp = parsed;
			}
		}

		// Fetch messages with pagination support at DB level
		// For 'before' cursor, we need messages older than a timestamp
		// For initial load, we want the newest messages
		const fetchSessionMessages = (
			sessionId: string,
			options?: { beforeTimestamp?: number; fetchLimit?: number }
		): unknown[] => {
			const fetchLimit = options?.fetchLimit ?? limit;
			const before = options?.beforeTimestamp;
			const page = sdkRepo.getSDKMessages(sessionId, fetchLimit, before);
			return page.messages;
		};

		const workerMessages = fetchSessionMessages(group.workerSessionId, { beforeTimestamp });
		const leaderMessages = fetchSessionMessages(group.leaderSessionId, { beforeTimestamp });

		const toEnrichedTimeline = (messages: unknown[], sessionId: string, role: string) => {
			const shortSessionId = sessionId.slice(0, 8);
			return messages.map((message, idx) => {
				const messageObj = message as Record<string, unknown>;
				const timestamp =
					typeof messageObj.timestamp === 'number' ? messageObj.timestamp : Date.now();
				const uuid = typeof messageObj.uuid === 'string' ? messageObj.uuid : `${idx}`;
				const turnId = `turn_${group.id}_${group.feedbackIteration}_${shortSessionId}_${uuid}`;
				const { sendStatus: _sendStatus, ...messageWithoutSendStatus } = messageObj;
				const enriched = {
					...messageWithoutSendStatus,
					_taskMeta: {
						authorRole: role,
						authorSessionId: sessionId,
						turnId,
						iteration: group.feedbackIteration,
					},
				};
				const sourceKey = `sdk:${sessionId}:${uuid}`;
				return {
					createdAt: timestamp,
					sourceKey,
					groupId: group.id,
					sessionId,
					role,
					messageType: typeof messageObj.type === 'string' ? messageObj.type : 'unknown',
					content: JSON.stringify(enriched),
				};
			});
		};

		// Fetch group events with pagination
		const fetchGroupEvents = (groupId: string, options?: { limit?: number }) => {
			const limit = options?.limit ?? 500;
			const page = groupRepo.getEvents(groupId, { limit });
			return page.events;
		};
		const groupEvents = fetchGroupEvents(group.id);

		const merged = [
			...toEnrichedTimeline(workerMessages as unknown[], group.workerSessionId, group.workerRole),
			...toEnrichedTimeline(leaderMessages as unknown[], group.leaderSessionId, 'leader'),
			...groupEvents.map((event) => {
				let text = event.kind;
				if (event.payloadJson) {
					try {
						const parsed = JSON.parse(event.payloadJson) as { text?: string };
						if (parsed.text) text = parsed.text;
					} catch {
						// keep default text
					}
				}
				return {
					createdAt: event.createdAt,
					sourceKey: `event:${event.id}`,
					groupId: event.groupId,
					sessionId: null,
					role: 'system',
					messageType: event.kind === 'leader_summary' ? 'leader_summary' : 'status',
					content: text,
				};
			}),
		]
			.sort((a, b) => {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return a.sourceKey.localeCompare(b.sourceKey);
			})
			.map((msg) => ({
				cursor: `${String(msg.createdAt).padStart(16, '0')}|${msg.sourceKey}`,
				...msg,
			}));

		const beforeCursor = params.before;
		const afterCursor = params.cursor;

		let filtered = merged;
		let hasOlder = false;

		if (beforeCursor) {
			// Load older messages: return messages with cursor < beforeCursor
			filtered = merged.filter((m) => m.cursor < beforeCursor);
			// Sort in descending order to get the newest of the older messages
			filtered.sort((a, b) => b.cursor.localeCompare(a.cursor));
			const page = filtered.slice(0, limit + 1);
			hasOlder = page.length > limit;
			const messages = page.slice(0, limit).map((msg, idx) => ({
				id: idx + 1,
				groupId: msg.groupId,
				sessionId: msg.sessionId,
				role: msg.role,
				messageType: msg.messageType,
				content: msg.content,
				createdAt: msg.createdAt,
				cursor: msg.cursor,
			}));
			// Re-sort messages in chronological order for display
			messages.sort((a, b) => a.createdAt - b.createdAt);
			// After re-sorting, messages[0] is the oldest
			const oldestCursor = messages.length > 0 ? messages[0].cursor : null;
			return { messages, hasMore: false, nextCursor: null, hasOlder, oldestCursor };
		}

		if (afterCursor) {
			// Load newer messages: return messages with cursor > afterCursor
			filtered = merged.filter((m) => m.cursor > afterCursor);
			const page = filtered.slice(0, limit + 1);
			const hasMore = page.length > limit;
			const messages = page.slice(0, limit).map((msg, idx) => ({
				id: idx + 1,
				groupId: msg.groupId,
				sessionId: msg.sessionId,
				role: msg.role,
				messageType: msg.messageType,
				content: msg.content,
				createdAt: msg.createdAt,
				cursor: msg.cursor,
			}));
			const nextCursor = messages.length > 0 ? messages[messages.length - 1].cursor : null;
			return { messages, hasMore, nextCursor, hasOlder: false, oldestCursor: null };
		}

		// Initial load: return the newest `limit` messages
		// Sort in descending order to get newest first
		filtered.sort((a, b) => b.cursor.localeCompare(a.cursor));
		const page = filtered.slice(0, limit + 1);
		hasOlder = page.length > limit;
		const messages = page.slice(0, limit).map((msg, idx) => ({
			id: idx + 1,
			groupId: msg.groupId,
			sessionId: msg.sessionId,
			role: msg.role,
			messageType: msg.messageType,
			content: msg.content,
			createdAt: msg.createdAt,
			cursor: msg.cursor,
		}));
		// Re-sort messages in chronological order for display
		messages.sort((a, b) => a.createdAt - b.createdAt);
		// After re-sorting, messages[0] is the oldest, messages[length-1] is the newest
		const oldestCursor = messages.length > 0 ? messages[0].cursor : null;
		const nextCursor = messages.length > 0 ? messages[messages.length - 1].cursor : null;

		return { messages, hasMore: false, nextCursor, hasOlder, oldestCursor };
	});

	// task.group.addMessage and task.group.create are non-production test/admin RPCs.
	// They are only registered when NODE_ENV is not 'production' to prevent exposure
	// of raw DB write access to production clients.
	if (process.env.NODE_ENV !== 'production') {
		// task.group.addMessage - insert a synthetic canonical timeline row for E2E.
		// Writes to task_group_events (system/status-like rows) or sdk_messages (agent rows).
		messageHub.onRequest('task.group.addMessage', async (data) => {
			const params = data as {
				groupId: string;
				role: string;
				messageType: string;
				content: string;
				sessionId?: string;
			};

			if (!params.groupId) throw new Error('Group ID is required');
			if (!params.role) throw new Error('Role is required');
			if (!params.content) throw new Error('Content is required');

			const groupRepo = makeGroupRepo();
			const group = groupRepo.getGroup(params.groupId);
			if (!group) throw new Error(`Group not found: ${params.groupId}`);

			const messageType = params.messageType ?? 'assistant';
			const isSystemLike =
				params.role === 'system' ||
				messageType === 'status' ||
				messageType === 'leader_summary' ||
				messageType === 'rate_limited' ||
				messageType === 'model_fallback';

			if (isSystemLike) {
				const kind =
					messageType === 'leader_summary'
						? 'leader_summary'
						: messageType === 'rate_limited'
							? 'rate_limited'
							: messageType === 'model_fallback'
								? 'model_fallback'
								: 'status';

				let payloadJson: string;
				if (kind === 'rate_limited' || kind === 'model_fallback') {
					try {
						JSON.parse(params.content);
						payloadJson = params.content;
					} catch {
						payloadJson = JSON.stringify({ text: params.content });
					}
				} else {
					payloadJson = JSON.stringify({ text: params.content });
				}

				const id = groupRepo.appendEvent({
					groupId: params.groupId,
					kind,
					payloadJson,
				});
				return { id };
			}

			const dbInstance = db.getDatabase();
			const { generateUUID } = await import('@neokai/shared');
			const rowId = generateUUID();
			const sessionId =
				params.sessionId ??
				(params.role === 'leader' || params.role === 'lead'
					? group.leaderSessionId
					: group.workerSessionId);

			let sdkPayload: Record<string, unknown>;
			try {
				sdkPayload = JSON.parse(params.content) as Record<string, unknown>;
			} catch {
				sdkPayload = {
					type: messageType,
					uuid: generateUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: params.content }],
					},
				};
			}

			dbInstance
				.prepare(
					`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					rowId,
					sessionId,
					typeof sdkPayload.type === 'string' ? sdkPayload.type : messageType,
					null,
					JSON.stringify(sdkPayload),
					new Date().toISOString(),
					'consumed'
				);
			reactiveDb.notifyChange('sdk_messages');
			return { id: rowId };
		});

		// task.group.create - create a synthetic session group for a task.
		// Intended only for E2E test infrastructure to set up message streaming scenarios
		// without running real agents.
		messageHub.onRequest('task.group.create', async (data) => {
			const params = data as {
				taskId: string;
				roomId: string;
				workerSessionId?: string;
				leaderSessionId?: string;
			};

			if (!params.taskId) throw new Error('Task ID is required');
			if (!params.roomId) throw new Error('Room ID is required');

			const { generateUUID } = await import('@neokai/shared');
			const groupId = generateUUID();
			const now = Date.now();
			const workerSessionId = params.workerSessionId ?? `e2e-worker-${groupId.slice(0, 8)}`;
			const leaderSessionId = params.leaderSessionId ?? `e2e-leader-${groupId.slice(0, 8)}`;

			const dbInstance = db.getDatabase();
			dbInstance.run(
				`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
         VALUES (?, 'task', ?, 0, ?, ?)`,
				[
					groupId,
					params.taskId,
					JSON.stringify({
						feedbackIteration: 0,
						workerRole: 'coder',
						leaderContractViolations: 0,
						leaderCalledTool: false,
						lastProcessedLeaderTurnId: null,
						lastForwardedMessageId: null,
						activeWorkStartedAt: null,
						activeWorkElapsed: 0,
						hibernatedAt: null,
						tokensUsed: 0,
					}),
					now,
				]
			);
			dbInstance.run(
				`INSERT INTO session_group_members (group_id, session_id, role, joined_at) VALUES (?, ?, 'worker', ?)`,
				[groupId, workerSessionId, now]
			);
			dbInstance.run(
				`INSERT INTO session_group_members (group_id, session_id, role, joined_at) VALUES (?, ?, 'leader', ?)`,
				[groupId, leaderSessionId, now]
			);

			// Notify reactive listeners that session_groups changed (e.g. LiveQuery subscriptions
			// that watch this table will re-evaluate).
			reactiveDb.notifyChange('session_groups');

			return { groupId, workerSessionId, leaderSessionId };
		});
	}

	// task.sendHumanMessage - Send a human message to the worker or leader in a task group
	messageHub.onRequest('task.sendHumanMessage', async (data) => {
		const params = data as {
			roomId: string;
			taskId: string;
			message: string;
			target?: 'worker' | 'leader';
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.message) {
			throw new Error('Message is required');
		}
		if (!params.message.trim()) {
			throw new Error('Message cannot be empty');
		}
		if (params.message.length > 10_000) {
			throw new Error('Message is too long (max 10,000 characters)');
		}
		const target = params.target ?? 'worker';
		if (target !== 'worker' && target !== 'leader') {
			throw new Error(`Invalid target: ${target}`);
		}
		// Cross-room ownership check: verify the task belongs to this room.
		// TaskManager is room-scoped, so getTask() returns null for tasks in other rooms.
		const taskId = resolveTaskId(params.taskId, params.roomId, makeTaskRepo());
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found in room ${params.roomId}`);
		}

		// Archived tasks are truly terminal — no messaging allowed. Check this before the runtime
		// lookup so the error is consistent regardless of whether a runtime is active.
		if (task.status === 'archived') {
			throw new Error(
				`Task ${taskId} is archived and cannot receive messages. Archive is a terminal state.`
			);
		}

		if (!runtimeService) {
			throw new Error('Runtime service is required for task.sendHumanMessage');
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		// needs_attention, completed, and cancelled tasks: auto-reactivate via reviveTaskForMessage.
		// reviveTaskForMessage is a lightweight revive that restores sessions and injects the
		// message WITHOUT wiping the group metadata or conversation history.
		//
		// Note — deliberate asymmetry with task.setStatus:
		//   task.setStatus(cancelled → in_progress)  → resetGroupForRestart (clean slate)
		//   task.sendHumanMessage(cancelled task)     → reviveTaskForMessage  (keep history)
		// Sending a message to a cancelled task is a "continue this conversation" action, so
		// we preserve context. Explicitly restarting via setStatus is a "start over" action.
		if (
			task.status === 'needs_attention' ||
			task.status === 'completed' ||
			task.status === 'cancelled'
		) {
			// needs_attention transitions through 'review' (its prior working state);
			// completed/cancelled transition directly to 'in_progress' as the pre-revival
			// intermediate status before reviveTaskForMessage restores sessions.
			const intermediateStatus = task.status === 'needs_attention' ? 'review' : 'in_progress';
			try {
				await taskManager.setTaskStatus(taskId, intermediateStatus);
			} catch (err) {
				throw new Error(`Failed to revive task ${taskId}: ${String(err)}`);
			}

			const revived = await runtime.reviveTaskForMessage(taskId, params.message.trim(), target);
			if (!revived) {
				// Rollback: restore task to original status
				try {
					await taskManager.setTaskStatus(taskId, task.status);
				} catch {
					// Best-effort rollback; swallow to avoid masking the revive error
				}
				throw new Error(
					`Failed to revive task ${taskId}: agent sessions could not be restored. ` +
						`Task status has been reset to ${task.status}.`
				);
			}

			// reviveTaskForMessage already emits task updates internally — no extra emit needed.
			return { success: true };
		}

		// review tasks: transition to in_progress before routing the human message.
		// The group is still active (sessions running), so no revival is needed — just
		// update the status so the task reflects that work is ongoing again.
		let wasInReview = false;
		if (task.status === 'review') {
			try {
				await taskManager.setTaskStatus(taskId, 'in_progress');
				wasInReview = true;
			} catch (err) {
				throw new Error(
					`Failed to transition task ${taskId} from review to in_progress: ${String(err)}`
				);
			}
		}

		// rate_limited/usage_limited tasks: clear the group's rate limit so the message can be
		// routed normally. clearGroupRateLimit() also restores the task status to in_progress
		// and clears any task restrictions. Falls through to the generic
		// routeHumanMessageToGroup() call below. If clearGroupRateLimit returns false (no
		// group found), we continue anyway — routeHumanMessageToGroup will surface the error.
		if (task.status === 'rate_limited' || task.status === 'usage_limited') {
			await runtime.clearGroupRateLimit(taskId);
		}

		const groupRepo = makeGroupRepo();

		// in_progress tasks with no active group: this can happen when task.setStatus() transitions
		// a task back to in_progress (e.g., after a phase transition) without creating a new group.
		// Revive the task so a fresh execution group is created and the message can be delivered.
		if (task.status === 'in_progress' && groupRepo.getActiveGroupsForTask(taskId).length === 0) {
			const revived = await runtime.reviveTaskForMessage(taskId, params.message.trim(), target);
			if (!revived) {
				throw new Error(
					`Failed to revive task ${taskId}: no active group and revival failed. ` +
						`Use task.setStatus to restart the task explicitly.`
				);
			}
			return { success: true };
		}

		// When the task was in review, prepend a context note so the leader knows to
		// re-submit for review after addressing the human's feedback.
		const reviewReminder = wasInReview
			? `[Context: This task was in \`review\` status. The message below is human feedback. After addressing the feedback, call \`submit_for_review\` to re-submit for human approval.]\n\n`
			: '';
		const messageToRoute = reviewReminder + params.message.trim();

		const result = await routeHumanMessageToGroup(
			runtime,
			groupRepo,
			taskId,
			messageToRoute,
			target
		);

		if (!result.success) {
			throw new Error(result.error ?? 'Failed to send human message');
		}

		return { success: true };
	});

	// session_group.stop - Force-stop a session group by ID.
	// Kills worker and leader agent sessions and removes the group record from the DB.
	// Frees the concurrency slot so the runtime can pick up new tasks.
	// Task status is NOT changed; call task.cancel separately if needed.
	messageHub.onRequest('session_group.stop', async (data) => {
		const params = data as { roomId: string; groupId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.groupId) {
			throw new Error('Group ID is required');
		}

		if (!runtimeService) {
			throw new Error('Runtime service is required for session_group.stop');
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		const result = await runtime.forceStopSessionGroup(params.groupId);
		if (!result.success) {
			throw new Error(result.error ?? `Failed to stop session group ${params.groupId}`);
		}

		// TODO: remove once session LiveQuery covers list
		emitRoomOverview(params.roomId);
		return { success: true };
	});

	// inbox.reviewTasks - Get all review-status tasks across all active rooms.
	// Replaces the client-side fan-out of room.get calls with a single targeted query
	// that only reads task rows (no session/overview overhead).
	messageHub.onRequest('inbox.reviewTasks', async () => {
		const rooms = roomManager.listRooms(false);
		const taskRepo = makeTaskRepo();
		const reviewTasks: Array<{ task: TaskSummary; roomId: string; roomTitle: string }> = [];

		for (const room of rooms) {
			const tasks = taskRepo.listTasks(room.id, { status: 'review' });
			for (const task of tasks) {
				reviewTasks.push({
					task: toTaskSummary(task),
					roomId: room.id,
					roomTitle: room.name,
				});
			}
		}

		reviewTasks.sort((a, b) => b.task.updatedAt - a.task.updatedAt);
		return { tasks: reviewTasks };
	});
}
