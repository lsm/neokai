/**
 * Space Agent Tools — MCP tools for the Space leader agent session.
 *
 * These tools allow the Space agent to inspect workflows, manage existing
 * workflow runs, and create/query Space tasks. They are in the Space namespace
 * (not Room).
 *
 * Tools (per M7 spec):
 *   list_workflows      — show all workflows with their descriptions and steps
 *   get_workflow_run    — check the status of a running workflow
 *   change_plan         — update task description or switch to a different workflow mid-run
 *   list_tasks          — see current and past tasks
 *   get_workflow_detail — get a specific workflow's full definition (steps, transitions, rules)
 *   suggest_workflow    — get workflow recommendations for a described piece of work
 *
 * Design note: workflow selection is LLM-driven and task-first. The agent uses
 * workflow discovery tools to reason about orchestration, then creates a task.
 * Runtime attaches and advances workflow execution from the task lifecycle.
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceTask, SpaceTaskStatus, SpaceTaskPriority } from '@neokai/shared';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { TaskAgentManager } from '../runtime/task-agent-manager';
import type { DaemonHub } from '../../daemon-hub';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import { canTransition } from '../runtime/workflow-run-status-machine';
import { enrichTaskWithPendingAction } from '../runtime/pending-action';

function normalizeAgentNameToken(value: string): string {
	return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceAgentToolsConfig {
	/** The Space this agent is operating within. */
	spaceId: string;
	/** SpaceRuntime for starting and managing workflow runs. */
	runtime: SpaceRuntime;
	/** Workflow manager for listing available workflows. */
	workflowManager: SpaceWorkflowManager;
	/** Task repository for read queries (list/filter). */
	taskRepo: SpaceTaskRepository;
	/** Node execution repository for workflow run node execution queries. */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Workflow run repository for listing and updating runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task manager for create/retry/cancel/reassign operations. */
	taskManager: SpaceTaskManager;
	/** Space agent manager for reassign validation. */
	spaceAgentManager: SpaceAgentManager;
	/**
	 * Task Agent Manager for injecting messages into running task agent sessions.
	 * When provided, enables the `send_message_to_task` and `list_task_members` tools.
	 */
	taskAgentManager?: TaskAgentManager;
	/** Gate data repository for approve_gate tool. */
	gateDataRepo?: GateDataRepository;
	/** DaemonHub for emitting gate/task events. */
	daemonHub?: DaemonHub;
	/** Callback to trigger channel re-evaluation after gate data changes. */
	onGateChanged?: (runId: string, gateId: string) => void;
	/**
	 * Resolves the space's current autonomy level.
	 * Required for approve_gate autonomy enforcement: agent approvals are rejected
	 * when space autonomy < gate.requiredLevel (default 5 if gate has no requiredLevel).
	 */
	getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
	/**
	 * The calling agent's name (e.g., 'space-agent'). Used for gate writer authorization
	 * in approve_gate: the writers path is taken only when writers include this name or '*'.
	 * When omitted, only '*' in writers can match (falls back to autonomy path otherwise).
	 */
	myAgentName?: string;
	/**
	 * Optional name aliases for the calling agent. Checked alongside myAgentName during
	 * writer authorization.
	 */
	myAgentNameAliases?: string[];
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 * Returns a map of tool name → handler function.
 */
export function createSpaceAgentToolHandlers(config: SpaceAgentToolsConfig) {
	const {
		spaceId,
		runtime,
		workflowManager,
		taskRepo,
		nodeExecutionRepo,
		workflowRunRepo,
		taskManager,
		spaceAgentManager,
		taskAgentManager,
		gateDataRepo,
		daemonHub,
		onGateChanged,
		getSpaceAutonomyLevel,
		myAgentName,
		myAgentNameAliases,
	} = config;

	const agentNameAliases = new Set(
		[myAgentName, ...(myAgentNameAliases ?? [])]
			.filter((v): v is string => typeof v === 'string')
			.map((v) => normalizeAgentNameToken(v))
			.filter((v) => v.length > 0)
	);

	return {
		/**
		 * List all available SpaceWorkflow records for this space.
		 * The LLM agent calls this first to understand available options.
		 */
		async list_workflows(): Promise<ToolResult> {
			const workflows = workflowManager.listWorkflows(spaceId);
			return jsonResult({ success: true, workflows });
		},

		/**
		 * Get the current status of a workflow run, including its current step.
		 */
		async get_workflow_run(args: { run_id: string }): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}

			// Include node executions for this run
			const executions = nodeExecutionRepo.listByWorkflowRun(run.id);

			return jsonResult({ success: true, run, executions });
		},

		/**
		 * Update the current workflow run's task description, or switch to a
		 * different workflow mid-run (cancels the current run and starts a new one).
		 *
		 * - Provide `description` to update the run description in place.
		 * - Provide `workflow_id` to switch workflows: the current run is cancelled
		 *   and a new run is started with the same title and updated description.
		 */
		async change_plan(args: {
			run_id: string;
			description?: string;
			workflow_id?: string;
		}): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}

			if (run.status === 'done' || run.status === 'cancelled') {
				return jsonResult({
					success: false,
					error: `Cannot change plan for a ${run.status} run.`,
				});
			}

			// Switching workflow: validate the target workflow exists BEFORE cancelling
			// the old run, so a bad workflow_id never leaves the user with no active run.
			if (args.workflow_id) {
				const targetWorkflow = workflowManager.getWorkflow(args.workflow_id);
				if (!targetWorkflow) {
					return jsonResult({
						success: false,
						error: `Workflow not found: ${args.workflow_id}`,
					});
				}

				workflowRunRepo.transitionStatus(run.id, 'cancelled');

				try {
					const newDescription = args.description ?? run.description;
					const { run: newRun, tasks } = await runtime.startWorkflowRun(
						spaceId,
						args.workflow_id,
						run.title,
						newDescription
					);
					return jsonResult({
						success: true,
						previousRunId: run.id,
						run: newRun,
						tasks,
						message: `Switched from workflow "${run.workflowId}" to "${args.workflow_id}". Previous run cancelled.`,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return jsonResult({ success: false, error: message });
				}
			}

			// Description-only update.
			if (args.description !== undefined) {
				const updated = workflowRunRepo.updateRun(run.id, { description: args.description });
				return jsonResult({ success: true, run: updated });
			}

			return jsonResult({
				success: false,
				error: 'Provide at least one of: description, workflow_id.',
			});
		},

		/**
		 * Get the full definition of a specific workflow — steps, transitions, and rules.
		 * Use this when list_workflows gives enough name/description to narrow down to one
		 * candidate and you want to inspect its complete structure before starting a run.
		 */
		async get_workflow_detail(args: { workflow_id: string }): Promise<ToolResult> {
			const workflow = workflowManager.getWorkflow(args.workflow_id);
			if (!workflow) {
				return jsonResult({ success: false, error: `Workflow not found: ${args.workflow_id}` });
			}
			return jsonResult({ success: true, workflow });
		},

		/**
		 * Return all workflows in the space so the Space Agent LLM can pick one.
		 *
		 * Previously this tool did keyword pre-ranking, but that could bias the
		 * LLM toward a substring-overlap pick (e.g. a "review feedback" task
		 * always surfacing a "review" workflow first). Selection is fully
		 * LLM-driven, so we just expose the full catalogue and let the caller
		 * reason over it.
		 *
		 * The `description` argument is retained for forward compatibility and
		 * call-site clarity, but is not used by the handler. Callers can still
		 * read it from structured tool logs for observability.
		 */
		async suggest_workflow(_args: { description: string }): Promise<ToolResult> {
			const allWorkflows = workflowManager.listWorkflows(spaceId);
			if (allWorkflows.length === 0) {
				return jsonResult({
					success: true,
					workflows: [],
					message: 'No workflows available in this space.',
				});
			}
			return jsonResult({ success: true, workflows: allWorkflows });
		},

		/**
		 * List SpaceTasks for this space, optionally filtered by status and/or workflowRunId.
		 *
		 * Tasks in the non-compact output are enriched with `pendingAction` when they are
		 * paused at a completion action, so consumers can render an approval banner
		 * without a second fetch.
		 */
		async list_tasks(args: {
			status?: SpaceTaskStatus;
			workflow_run_id?: string;
			search?: string;
			limit?: number;
			offset?: number;
			compact?: boolean;
		}): Promise<ToolResult> {
			let tasks: SpaceTask[];
			if (args.workflow_run_id) {
				tasks = taskRepo.listByWorkflowRun(args.workflow_run_id);
				if (args.status) {
					tasks = tasks.filter((t) => t.status === args.status);
				}
			} else if (args.status) {
				tasks = taskRepo.listByStatus(spaceId, args.status);
			} else {
				tasks = taskRepo.listBySpace(spaceId);
			}
			if (args.search) {
				const q = args.search.toLowerCase();
				tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
			}
			const total = tasks.length;
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			tasks = tasks.slice(offset, offset + limit);
			if (args.compact) {
				const compactTasks = tasks.map((t) => ({
					id: t.id,
					title: t.title,
					status: t.status,
					priority: t.priority,
					createdAt: t.createdAt,
				}));
				return jsonResult({ success: true, total, tasks: compactTasks });
			}
			const enrichedTasks = tasks.map((t) =>
				enrichTaskWithPendingAction(t, workflowRunRepo, workflowManager)
			);
			return jsonResult({ success: true, total, tasks: enrichedTasks });
		},

		/**
		 * Create a standalone task not associated with any workflow run.
		 */
		async create_standalone_task(args: {
			title: string;
			description: string;
			priority?: SpaceTaskPriority;
			workflow_id?: string;
		}): Promise<ToolResult> {
			try {
				const task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					preferredWorkflowId: args.workflow_id ?? null,
				});
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Get the full detail of a task by UUID or by numeric task number (e.g. #5).
		 *
		 * When the task is paused at a completion action (`pendingCheckpointType ===
		 * 'completion_action'`), the returned task is enriched with a `pendingAction`
		 * field describing the action awaiting approval. Script bodies, instruction
		 * prompts, and MCP tool args are omitted — consumers fetch the workflow for those.
		 */
		async get_task_detail(args: { task_id?: string; task_number?: number }): Promise<ToolResult> {
			let task: SpaceTask | null = null;
			if (args.task_number !== undefined) {
				task = await taskManager.getTaskByNumber(args.task_number);
			} else if (args.task_id) {
				task = await taskManager.getTask(args.task_id);
			} else {
				return jsonResult({
					success: false,
					error: 'Either task_id or task_number is required',
				});
			}
			if (!task) {
				const ref = args.task_number !== undefined ? `#${args.task_number}` : args.task_id;
				return jsonResult({ success: false, error: `Task not found: ${ref}` });
			}
			const enriched = enrichTaskWithPendingAction(task, workflowRunRepo, workflowManager);
			return jsonResult({ success: true, task: enriched });
		},

		/**
		 * Retry a failed or cancelled task by resetting it to pending.
		 */
		async retry_task(args: { task_id: string; description?: string }): Promise<ToolResult> {
			try {
				const task = await taskManager.retryTask(args.task_id, {
					description: args.description,
				});
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Cancel a task and optionally cancel its workflow run.
		 * Cascades cancellation to pending dependent tasks automatically.
		 */
		async cancel_task(args: {
			task_id: string;
			cancel_workflow_run?: boolean;
		}): Promise<ToolResult> {
			try {
				const task = await taskManager.cancelTask(args.task_id);

				if (args.cancel_workflow_run && task.workflowRunId) {
					// Only cancel if the run exists and the transition is valid (not already terminal).
					const existingRun = workflowRunRepo.getRun(task.workflowRunId);
					const runCancelled =
						existingRun !== null && canTransition(existingRun.status, 'cancelled');
					if (runCancelled) {
						workflowRunRepo.transitionStatus(task.workflowRunId, 'cancelled');
					}
					return jsonResult({
						success: true,
						task,
						workflowRunCancelled: runCancelled,
						workflowRunId: task.workflowRunId,
					});
				}

				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Reassign a task to a different agent.
		 */
		async reassign_task(args: {
			task_id: string;
			custom_agent_id?: string | null;
			assigned_agent?: 'coder' | 'general';
		}): Promise<ToolResult> {
			try {
				// Validate custom_agent_id if being set to a non-null value
				if (args.custom_agent_id != null) {
					const agent = spaceAgentManager.getById(args.custom_agent_id);
					if (!agent) {
						return jsonResult({
							success: false,
							error: `Custom agent not found: ${args.custom_agent_id}`,
						});
					}
				}

				// Pass args.custom_agent_id as-is (including undefined) so the manager
				// only updates that field when it was explicitly provided.
				const task = await taskManager.reassignTask(
					args.task_id,
					args.custom_agent_id,
					args.assigned_agent
				);
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Inject a message into a running task agent session.
		 */
		async send_message_to_task(args: { task_id: string; message: string }): Promise<ToolResult> {
			if (!taskAgentManager) {
				return jsonResult({
					success: false,
					error: 'Task agent communication is not available in this context.',
				});
			}
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			try {
				await taskAgentManager.injectTaskAgentMessage(args.task_id, args.message);
				return jsonResult({ success: true, task_id: args.task_id });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List all node executions for a task's workflow run.
		 */
		async list_task_members(args: { task_id: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			if (!task.workflowRunId) {
				return jsonResult({
					success: true,
					task_id: args.task_id,
					executions: [],
					message: 'This task has no associated workflow run.',
				});
			}
			const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
			return jsonResult({ success: true, task_id: args.task_id, executions });
		},

		/**
		 * Approve or reject a workflow gate.
		 * Requires gateDataRepo to be configured.
		 */
		async approve_gate(args: {
			run_id: string;
			gate_id: string;
			approved: boolean;
			reason?: string;
		}): Promise<ToolResult> {
			if (!gateDataRepo) {
				return jsonResult({ success: false, error: 'Gate operations are not available' });
			}

			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}
			if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
				return jsonResult({
					success: false,
					error: `Cannot modify gate on a ${run.status} workflow run`,
				});
			}

			// Per-field two-path authorization for agent-originated approvals.
			// Writers path: 'approved' field's writers includes this agent's name or '*' → allow.
			// Autonomy path: writers don't include this agent (or empty writers) → require
			// space.autonomyLevel >= gate.requiredLevel (default 5).
			// Human approval via spaceWorkflowRun.approveGate RPC is not subject to this check.
			if (args.approved && getSpaceAutonomyLevel) {
				const workflow = workflowManager.getWorkflow(run.workflowId);
				const gateDef = (workflow?.gates ?? []).find((g) => g.id === args.gate_id);
				const approvedField = (gateDef?.fields ?? []).find((f) => f.name === 'approved');
				const writers = approvedField?.writers ?? [];
				const writerMatches = writers.some((w) => {
					const normalized = normalizeAgentNameToken(w);
					return normalized === '*' || agentNameAliases.has(normalized);
				});

				if (!writerMatches) {
					// Autonomy path: this agent is not in the writers list
					const effectiveRequiredLevel = gateDef?.requiredLevel ?? 5;
					const spaceLevel = await getSpaceAutonomyLevel(spaceId);
					if (spaceLevel < effectiveRequiredLevel) {
						return jsonResult({
							success: false,
							error:
								`Agent approval blocked: gate "${args.gate_id}" requires autonomy level ` +
								`${effectiveRequiredLevel} but space autonomy is ${spaceLevel}. ` +
								`Increase space autonomy level or request human approval.`,
						});
					}
				}
				// Writers path: writerMatches → no autonomy check needed
			}

			const existing = gateDataRepo.get(args.run_id, args.gate_id);

			if (args.approved) {
				if (existing?.data?.approved === true) {
					return jsonResult({
						success: true,
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already approved',
					});
				}

				const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
					approved: true,
					approvedAt: Date.now(),
					approvalSource: 'agent',
				});

				// If previously rejected, transition back to in_progress
				let currentRun = run;
				if (run.status === 'blocked' && run.failureReason === 'humanRejected') {
					currentRun = workflowRunRepo.transitionStatus(args.run_id, 'in_progress');
					currentRun =
						workflowRunRepo.updateRun(args.run_id, { failureReason: null }) ?? currentRun;
				}

				if (daemonHub) {
					void daemonHub
						.emit('space.workflowRun.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: run.id,
							run: currentRun,
						})
						.catch(() => {});
					void daemonHub
						.emit('space.gateData.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: args.run_id,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}
				onGateChanged?.(args.run_id, args.gate_id);

				return jsonResult({
					success: true,
					runId: args.run_id,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			} else {
				if (existing?.data?.approved === false) {
					return jsonResult({
						success: true,
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already rejected',
					});
				}

				const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
					approved: false,
					rejectedAt: Date.now(),
					reason: args.reason ?? null,
					approvalSource: 'agent',
				});

				if (run.status !== 'blocked') {
					workflowRunRepo.transitionStatus(args.run_id, 'blocked');
				}
				const updatedRun =
					workflowRunRepo.updateRun(args.run_id, { failureReason: 'humanRejected' }) ?? run;

				// Block the canonical task with gate_rejected reason
				const runTasks = taskRepo.listByWorkflowRun(args.run_id);
				const canonicalTask = runTasks[0];
				if (canonicalTask && canonicalTask.status !== 'blocked') {
					await taskManager.setTaskStatus(canonicalTask.id, 'blocked', {
						result: args.reason ?? 'Gate rejected',
						blockReason: 'gate_rejected',
					});
				}

				if (daemonHub) {
					void daemonHub
						.emit('space.workflowRun.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: run.id,
							run: updatedRun,
						})
						.catch(() => {});
					void daemonHub
						.emit('space.gateData.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: args.run_id,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}

				return jsonResult({
					success: true,
					runId: args.run_id,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			}
		},

		/**
		 * Approve a task that is in 'review' status, transitioning it to 'done'.
		 * Records approval audit trail with agent as the source.
		 */
		async approve_task(args: { task_id: string; reason?: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			if (task.status !== 'review') {
				return jsonResult({
					success: false,
					error: `Task is in '${task.status}' status, not 'review'. Only tasks in review can be approved.`,
				});
			}

			try {
				const updated = await taskManager.setTaskStatus(args.task_id, 'done', {
					result: task.result ?? undefined,
					approvalSource: 'agent',
					approvalReason: args.reason,
				});

				if (daemonHub) {
					void daemonHub
						.emit('space.task.updated', {
							sessionId: 'global',
							spaceId,
							taskId: args.task_id,
							task: updated,
						})
						.catch(() => {});
				}

				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all Space agent tools.
 * Pass the returned server to the SDK session init.
 */
export function createSpaceAgentMcpServer(config: SpaceAgentToolsConfig) {
	const handlers = createSpaceAgentToolHandlers(config);

	const tools = [
		tool(
			'list_workflows',
			'Show all workflows in this space with their descriptions and steps. Call this first to understand available options before creating a task.',
			{},
			() => handlers.list_workflows()
		),
		tool(
			'get_workflow_run',
			'Check the current status of a workflow run, including the current step and associated tasks.',
			{
				run_id: z.string().describe('ID of the workflow run to inspect'),
			},
			(args) => handlers.get_workflow_run(args)
		),
		tool(
			'change_plan',
			'Update the task description for an ongoing run, or switch to a different workflow mid-run (cancels the current run and starts a new one).',
			{
				run_id: z.string().describe('ID of the current workflow run'),
				description: z.string().optional().describe('Updated task description'),
				workflow_id: z
					.string()
					.optional()
					.describe(
						'New workflow ID to switch to. The current run will be cancelled and a new run started with the same title.'
					),
			},
			(args) => handlers.change_plan(args)
		),
		tool(
			'get_workflow_detail',
			'Get the full definition of a specific workflow, including all steps, transitions, and rules. Use this to inspect a candidate workflow before creating a task.',
			{
				workflow_id: z.string().describe('ID of the workflow to retrieve'),
			},
			(args) => handlers.get_workflow_detail(args)
		),
		tool(
			'suggest_workflow',
			'List all workflows available in this space so you can pick the best one for a described piece of work. Returns every workflow in creation order with its name, description, tags, and nodes — no pre-ranking, so your own reasoning is not biased by keyword overlap.',
			{
				description: z
					.string()
					.describe(
						'Description of the work you want to do. Provided for context; the tool returns all workflows regardless.'
					),
			},
			(args) => handlers.suggest_workflow(args)
		),
		tool(
			'list_tasks',
			'List SpaceTasks for this space. Filterable by status and workflow run. Use compact:true and limit/offset to reduce payload size.',
			{
				status: z
					.enum(['open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived'])
					.optional()
					.describe('Filter by task status'),
				workflow_run_id: z
					.string()
					.optional()
					.describe('Filter to only tasks belonging to a specific workflow run'),
				search: z.string().optional().describe('Substring match on task title'),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(50)
					.describe('Maximum number of tasks to return (default: 50)'),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe('Number of tasks to skip for pagination (default: 0)'),
				compact: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						'Return only summary fields (id, title, status, priority, createdAt) to reduce payload size'
					),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'create_standalone_task',
			'Create a task request. Runtime may attach and execute a workflow for this task during orchestration.',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed description of the work to be done'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Task priority (default: normal)'),
				custom_agent_id: z
					.string()
					.optional()
					.describe('ID of a custom Space agent to assign this task to'),
				workflow_id: z
					.string()
					.optional()
					.describe(
						'ID of the workflow to use for this task. When provided, the runtime uses this workflow instead of auto-selecting one. Example: "67b42e04-ae03-425d-b267-40527b042dcc" for Coding with QA Workflow.'
					),
			},
			(args) => handlers.create_standalone_task(args)
		),
		tool(
			'get_task_detail',
			'Retrieve detailed information about a specific task including its status, result, and metadata.',
			{
				task_id: z.string().optional().describe('UUID of the task to retrieve'),
				task_number: z
					.number()
					.optional()
					.describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id'),
			},
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'retry_task',
			'Retry a failed or cancelled task. Optionally update the task description for the retry attempt.',
			{
				task_id: z.string().describe('ID of the task to retry'),
				description: z
					.string()
					.optional()
					.describe('Updated task description for the retry attempt'),
			},
			(args) => handlers.retry_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task. Automatically cascades cancellation to pending dependent tasks. Optionally also cancel the associated workflow run.',
			{
				task_id: z.string().describe('ID of the task to cancel'),
				cancel_workflow_run: z
					.boolean()
					.optional()
					.describe(
						'If true and the task belongs to a workflow run, also cancel that workflow run'
					),
			},
			(args) => handlers.cancel_task(args)
		),
		tool(
			'reassign_task',
			'Change the agent assignment for a task. Only allowed for tasks in open, blocked, or cancelled status.',
			{
				task_id: z.string().describe('ID of the task to reassign'),
				custom_agent_id: z
					.string()
					.nullable()
					.optional()
					.describe(
						'ID of the custom Space agent to assign to. Pass null to clear the custom agent assignment.'
					),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Agent type to assign (coder or general)'),
			},
			(args) => handlers.reassign_task(args)
		),

		// Task agent communication tools
		tool(
			'send_message_to_task',
			'Inject a message into a running task agent session. Use this to provide real-time guidance, corrections, or context to a task that is currently executing.',
			{
				task_id: z
					.string()
					.describe('ID of the task whose agent session should receive the message'),
				message: z.string().describe('Message to inject into the task agent session'),
			},
			(args) => handlers.send_message_to_task(args)
		),
		tool(
			'list_task_members',
			"List all node executions (workflow member agents) for a task. Returns each node's status, result, and saved data. Use this to inspect the detailed execution state of a running or completed workflow task.",
			{
				task_id: z.string().describe('ID of the task to inspect'),
			},
			(args) => handlers.list_task_members(args)
		),
		tool(
			'approve_gate',
			'Approve or reject a workflow gate. Use this to control workflow progression by opening or closing gates on workflow runs.',
			{
				run_id: z.string().describe('ID of the workflow run'),
				gate_id: z.string().describe('ID of the gate to approve or reject'),
				approved: z.boolean().describe('true to approve (open gate), false to reject (block)'),
				reason: z.string().optional().describe('Reason for approval or rejection'),
			},
			(args) => handlers.approve_gate(args)
		),
		tool(
			'approve_task',
			"Approve a task in 'review' status, transitioning it to 'done'. Use this after reviewing a completed task's output to mark it as approved.",
			{
				task_id: z.string().describe('ID of the task to approve'),
				reason: z.string().optional().describe('Reason for approval'),
			},
			(args) => handlers.approve_task(args)
		),
	];

	return createSdkMcpServer({ name: 'space-agent', tools });
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
