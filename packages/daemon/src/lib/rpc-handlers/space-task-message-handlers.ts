/**
 * Space Task Message RPC Handlers
 *
 * RPC handlers for human ↔ Task Agent message routing:
 * - space.task.sendMessage — inject a human message into a Task Agent session
 * - space.task.getMessages — paginated snapshot of messages from a Task Agent session
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { AgentSession } from '../agent/agent-session';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { Logger } from '../logger';

const log = new Logger('space-task-message-handlers');

/**
 * Minimal interface for resetting per-channel cycle counters on a workflow run.
 * Implemented by `ChannelCycleRepository.resetAllForRun`.
 *
 * Extracted so the RPC handler stays decoupled from the concrete repository
 * class and can be unit-tested with a lightweight mock.
 */
export interface ChannelCycleResetter {
	/**
	 * Zero out `count` for every `channel_cycles` row belonging to `runId`.
	 * Returns the number of rows updated.
	 */
	resetAllForRun(runId: string): number;
}

/**
 * Extract @AgentName mentions from message text.
 * Matches patterns like @Coder, @code-reviewer, @planner_1
 * Returns a deduplicated list of mentioned agent names (preserving first occurrence order).
 * Names must start with a letter; digits, hyphens, underscores are allowed subsequently.
 */
export function parseMentions(text: string): string[] {
	const mentionRegex = /@([A-Za-z][A-Za-z0-9_-]*)/g;
	const seen = new Set<string>();
	const matches: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = mentionRegex.exec(text)) !== null) {
		const name = match[1];
		if (name && !seen.has(name)) {
			seen.add(name);
			matches.push(name);
		}
	}
	return matches;
}

/**
 * Minimal interface for NodeExecution lookup.
 * Allows the handler to resolve @mention targets without depending on the concrete repository class.
 */
export interface NodeExecutionLookup {
	listByWorkflowRun(
		workflowRunId: string
	): Array<{ agentName: string; agentSessionId: string | null; status: string }>;
}

/**
 * Minimal interface for interacting with the Task Agent manager.
 * Decouples RPC handlers from the concrete TaskAgentManager class.
 */
export interface TaskAgentManagerInterface {
	/** Ensure a Task Agent session exists for the given task and return latest task snapshot. */
	ensureTaskAgentSession(taskId: string): Promise<import('@neokai/shared').SpaceTask>;
	/** Inject a message into the Task Agent session for the given task. */
	injectTaskAgentMessage(taskId: string, message: string): Promise<void>;
	/** Returns the live AgentSession for the given task, or undefined if not spawned. */
	getTaskAgent(taskId: string): AgentSession | undefined;
	/**
	 * Optional: inject a message directly into a node agent sub-session by its session ID.
	 * Required for @mention routing to specific agents.
	 */
	injectSubSessionMessage?(subSessionId: string, message: string): Promise<void>;
}

/**
 * Register RPC handlers for human ↔ Task Agent message routing.
 *
 * Separate from `setupSpaceTaskHandlers` because it requires a live
 * `TaskAgentManager` instance, which is created after `SpaceRuntimeService`.
 *
 * Handlers:
 *   space.task.sendMessage  — inject a human message into a Task Agent session
 *   space.task.getMessages  — paginated snapshot of messages from a Task Agent session
 */
export function setupSpaceTaskMessageHandlers(
	messageHub: MessageHub,
	taskAgentManager: TaskAgentManagerInterface,
	db: Database,
	daemonHub: DaemonHub,
	nodeExecutionRepo?: NodeExecutionLookup,
	channelCycleResetter?: ChannelCycleResetter
): void {
	const taskRepo = new SpaceTaskRepository(db.getDatabase());

	/**
	 * Best-effort: failure to reset must not fail the RPC, since the reset is an
	 * observability/safety-cap side-effect rather than part of the message delivery
	 * contract. The emit is suppressed when no rows changed to avoid waking
	 * subscribers for a no-op.
	 */
	async function resetChannelCyclesOnHumanTouch(
		workflowRunId: string | null | undefined,
		taskId: string
	): Promise<void> {
		if (!channelCycleResetter || !workflowRunId) return;
		try {
			const rowsReset = channelCycleResetter.resetAllForRun(workflowRunId);
			log.info(
				`workflow.cycles.reset: runId=${workflowRunId} reason=human_touch taskId=${taskId} rowsReset=${rowsReset}`
			);
			if (rowsReset > 0) {
				await daemonHub.emit('space.workflowRun.cyclesReset', {
					sessionId: 'global',
					runId: workflowRunId,
					reason: 'human_touch',
					taskId,
					rowsReset,
				});
			}
		} catch (err) {
			log.warn(
				`workflow.cycles.reset: failed to reset cycles for task ${taskId}: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	// ─── space.task.ensureAgentSession ──────────────────────────────────────────
	messageHub.onRequest('space.task.ensureAgentSession', async (data) => {
		const params = data as { spaceId: string; taskId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		const updatedTask = await taskAgentManager.ensureTaskAgentSession(params.taskId);

		await daemonHub.emit('space.task.updated', {
			sessionId: 'global',
			spaceId: params.spaceId,
			taskId: params.taskId,
			task: updatedTask,
		});

		log.info(`space.task.ensureAgentSession: ensured session for task ${params.taskId}`);

		return {
			taskId: updatedTask.id,
			sessionId: updatedTask.taskAgentSessionId ?? null,
			task: updatedTask,
		};
	});

	// ─── space.task.sendMessage ─────────────────────────────────────────────────
	messageHub.onRequest('space.task.sendMessage', async (data) => {
		const params = data as { spaceId: string; taskId: string; message: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}
		if (!params.message || params.message.trim() === '') {
			throw new Error('message is required');
		}
		if (params.message.length > 10_000) {
			throw new Error('Message is too long (max 10,000 characters)');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		// ── @mention routing ──────────────────────────────────────────────────────
		// If the message contains @AgentName patterns AND the task is linked to a
		// workflow run, route directly to the matched node agent sessions.
		const mentions = parseMentions(params.message);

		if (
			mentions.length > 0 &&
			task.workflowRunId &&
			nodeExecutionRepo &&
			taskAgentManager.injectSubSessionMessage
		) {
			const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
			// Exclude only cancelled agents — they are truly terminal and will never process
			// messages. Idle agents (waiting for input), blocked agents (waiting on dependencies),
			// and pending agents are all reachable and should receive @mention messages.
			const activeAgents = executions.filter(
				(e) => e.agentSessionId !== null && e.status !== 'cancelled'
			);

			const routedTo: string[] = [];
			const notFound: string[] = [];

			for (const mention of mentions) {
				const matches = activeAgents.filter(
					(e) => e.agentName.toLowerCase() === mention.toLowerCase()
				);
				if (matches.length === 0) {
					notFound.push(mention);
				} else {
					// Inject into all matching sessions in parallel (independent operations)
					await Promise.all(
						matches.map((exec) =>
							taskAgentManager.injectSubSessionMessage!(exec.agentSessionId!, params.message)
						)
					);
					routedTo.push(mention);
				}
			}

			if (routedTo.length === 0) {
				// No mentions resolved — throw with available agent names
				const available = [...new Set(activeAgents.map((e) => e.agentName))].sort();
				throw new Error(
					`@mention not found: ${notFound.join(', ')}. Available agents: ${available.length > 0 ? available.join(', ') : 'none'}`
				);
			}

			log.info(
				`space.task.sendMessage: @mention routing to [${routedTo.join(', ')}] for task ${params.taskId}`
			);

			await resetChannelCyclesOnHumanTouch(task.workflowRunId, params.taskId);

			return {
				ok: true,
				routedTo,
				...(notFound.length > 0 ? { notFound } : {}),
			};
		}
		// ── end @mention routing ───────────────────────────────────────────────────

		// No @mentions (or routing prerequisites not met): route to Task Agent
		// Ensure a live Task Agent session exists before injecting. This recovers from:
		// - first message on a task that has not spawned yet
		// - persisted-but-not-live sessions after daemon restart
		const sessionBefore = task.taskAgentSessionId ?? null;
		const ensuredTask = await taskAgentManager.ensureTaskAgentSession(params.taskId);
		const sessionAfter = ensuredTask.taskAgentSessionId ?? null;

		if (sessionAfter !== sessionBefore) {
			await daemonHub.emit('space.task.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				taskId: params.taskId,
				task: ensuredTask,
			});
		}

		await taskAgentManager.injectTaskAgentMessage(params.taskId, params.message);
		log.info(`space.task.sendMessage: injected message into task ${params.taskId}`);

		// Human touch: `space.task.sendMessage` is the sole RPC boundary for
		// human→task messages, so every successful call here resets the
		// autonomous-cycle safety cap. Agent-to-agent paths (send_message tool
		// → flushPendingMessagesForTarget → injectSubSessionMessage) bypass this
		// RPC and are therefore correctly excluded from the reset.
		await resetChannelCyclesOnHumanTouch(task.workflowRunId, params.taskId);

		return { ok: true };
	});

	// ─── space.task.getMessages ─────────────────────────────────────────────────
	messageHub.onRequest('space.task.getMessages', async (data) => {
		const params = data as {
			spaceId: string;
			taskId: string;
			cursor?: string;
			limit?: number;
		};

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (!task.taskAgentSessionId) {
			throw new Error(`Task Agent session not started for task: ${params.taskId}`);
		}

		const sessionId = task.taskAgentSessionId;
		const limit = Math.max(1, Math.min(params.limit ?? 50, 200));

		// Parse cursor as a numeric timestamp for the `before` DB filter
		let before: number | undefined;
		if (params.cursor) {
			const parsed = Number(params.cursor);
			if (!Number.isNaN(parsed)) {
				before = parsed;
			}
		}

		// Prefer reading from the live in-memory session (if the Task Agent is active),
		// falling back to the DB for completed or restarted sessions.
		const liveSession = taskAgentManager.getTaskAgent(params.taskId);
		const { messages, hasMore } = liveSession
			? liveSession.getSDKMessages(limit, before)
			: db.getSDKMessages(sessionId, limit, before);

		return { messages, hasMore, sessionId };
	});
}
