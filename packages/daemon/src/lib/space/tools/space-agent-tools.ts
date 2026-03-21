/**
 * Space Agent Tools — MCP tools for the Space leader agent session.
 *
 * These tools allow the Space agent to start workflow runs, check status,
 * change plans, and query Space tasks. They are in the Space namespace (not Room).
 *
 * Tools (per M7 spec):
 *   list_workflows      — show all workflows with their descriptions and steps
 *   start_workflow_run  — begin a workflow run (requires explicit workflowId)
 *   get_workflow_run    — check the status of a running workflow
 *   change_plan         — update task description or switch to a different workflow mid-run
 *   list_tasks          — see current and past tasks
 *   get_workflow_detail — get a specific workflow's full definition (steps, transitions, rules)
 *   suggest_workflow    — get workflow recommendations for a described piece of work
 *
 * Design note: workflow selection is LLM-driven. The agent calls list_workflows,
 * reasons about which workflow fits the request, then calls start_workflow_run
 * with an explicit workflowId. There are no server-side heuristics.
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceTaskStatus, SpaceTaskPriority, SpaceTaskType } from '@neokai/shared';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { GoalRepository } from '../../../storage/repositories/goal-repository';
import { jsonResult, SUGGEST_WORKFLOW_STOP_WORDS } from './tool-result';
import type { ToolResult } from './tool-result';

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
	/** Workflow run repository for listing and updating runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task manager for create/retry/cancel/reassign operations. */
	taskManager: SpaceTaskManager;
	/** Space agent manager for reassign validation. */
	spaceAgentManager: SpaceAgentManager;
	/**
	 * Goal repository for marking goals complete. Optional — when omitted,
	 * `complete_goal` returns an error.
	 */
	goalRepo?: GoalRepository;
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
		workflowRunRepo,
		taskManager,
		spaceAgentManager,
		goalRepo,
	} = config;

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
		 * Start a new workflow run with an explicit workflowId.
		 * The agent must call list_workflows first and pick the right workflow.
		 */
		async start_workflow_run(args: {
			workflow_id: string;
			title: string;
			description?: string;
		}): Promise<ToolResult> {
			try {
				const { run, tasks } = await runtime.startWorkflowRun(
					spaceId,
					args.workflow_id,
					args.title,
					args.description
				);
				return jsonResult({ success: true, run, tasks });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Get the current status of a workflow run, including its current step.
		 */
		async get_workflow_run(args: { run_id: string }): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}

			// Include current step info if available
			let currentStep = null;
			if (run.currentStepId) {
				const workflow = workflowManager.getWorkflow(run.workflowId);
				if (workflow) {
					currentStep = workflow.steps.find((s) => s.id === run.currentStepId) ?? null;
				}
			}

			// Include tasks for this run
			const tasks = taskRepo.listByWorkflowRun(run.id);

			return jsonResult({ success: true, run, currentStep, tasks });
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

			if (run.status === 'completed' || run.status === 'cancelled') {
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

				workflowRunRepo.updateStatus(run.id, 'cancelled');

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
		 * Suggest workflows that best match a description of the intended work.
		 *
		 * Performs a case-insensitive keyword search over workflow names, descriptions,
		 * and tags. Always returns ALL available workflows, sorted by relevance
		 * (number of keyword hits descending). When no keywords match, all workflows
		 * are returned in creation order.
		 *
		 * Selection is still LLM-driven: the agent should use this to rank candidates
		 * and then call start_workflow_run with an explicit workflow_id.
		 */
		async suggest_workflow(args: { description: string }): Promise<ToolResult> {
			const allWorkflows = workflowManager.listWorkflows(spaceId);
			if (allWorkflows.length === 0) {
				return jsonResult({
					success: true,
					workflows: [],
					message: 'No workflows available in this space.',
				});
			}

			// Extract meaningful keywords (3+ chars, skip stop words)
			const keywords = args.description
				.toLowerCase()
				.split(/\W+/)
				.filter((w) => w.length >= 3 && !SUGGEST_WORKFLOW_STOP_WORDS.has(w));

			if (keywords.length === 0) {
				// No meaningful keywords — return all in creation order
				return jsonResult({ success: true, workflows: allWorkflows });
			}

			// Score each workflow by number of keyword hits; return all sorted by score
			const scored = allWorkflows.map((wf) => {
				const haystack = [wf.name, wf.description ?? '', ...(wf.tags ?? [])]
					.join(' ')
					.toLowerCase();
				const hits = keywords.filter((kw) => haystack.includes(kw)).length;
				return { workflow: wf, hits };
			});

			const anyHits = scored.some((s) => s.hits > 0);
			if (!anyHits) {
				// No keyword matches — return all so LLM can still reason
				return jsonResult({
					success: true,
					workflows: allWorkflows,
					message: 'No direct keyword matches found; returning all workflows for LLM selection.',
				});
			}

			// Stable sort descending by hits; 0-hit workflows appear at the end
			scored.sort((a, b) => b.hits - a.hits);
			return jsonResult({ success: true, workflows: scored.map((s) => s.workflow) });
		},

		/**
		 * List SpaceTasks for this space, optionally filtered by status and/or workflowRunId.
		 */
		async list_tasks(args: {
			status?: SpaceTaskStatus;
			workflow_run_id?: string;
		}): Promise<ToolResult> {
			let tasks;
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
			return jsonResult({ success: true, tasks });
		},

		/**
		 * Create a standalone task not associated with any workflow run.
		 */
		async create_standalone_task(args: {
			title: string;
			description: string;
			priority?: SpaceTaskPriority;
			task_type?: SpaceTaskType;
			assigned_agent?: 'coder' | 'general';
			custom_agent_id?: string;
			goal_id?: string;
		}): Promise<ToolResult> {
			try {
				// Validate custom_agent_id if provided
				if (args.custom_agent_id) {
					const agent = spaceAgentManager.getById(args.custom_agent_id);
					if (!agent) {
						return jsonResult({
							success: false,
							error: `Custom agent not found: ${args.custom_agent_id}`,
						});
					}
				}

				const task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					taskType: args.task_type,
					assignedAgent: args.assigned_agent,
					customAgentId: args.custom_agent_id,
					goalId: args.goal_id,
				});
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Mark a goal as successfully completed with a summary.
		 * Call this after verification confirms all tasks for the goal passed validation.
		 */
		async complete_goal(args: { goal_id: string; summary: string }): Promise<ToolResult> {
			if (!goalRepo) {
				return jsonResult({
					success: false,
					error: 'Goal repository not available — cannot complete goals in this context.',
				});
			}

			const goal = goalRepo.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}

			if (goal.status === 'completed') {
				return jsonResult({
					success: true,
					goal,
					message: `Goal "${goal.title}" is already marked as completed.`,
				});
			}

			if (goal.status === 'archived') {
				return jsonResult({
					success: false,
					error: `Cannot complete an archived goal: ${args.goal_id}`,
				});
			}

			const updated = goalRepo.updateGoal(args.goal_id, { status: 'completed' });
			return jsonResult({
				success: true,
				goal: updated,
				summary: args.summary,
				message: `Goal "${goal.title}" marked as completed.`,
			});
		},

		/**
		 * Get the full detail of a task by ID.
		 */
		async get_task_detail(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			return jsonResult({ success: true, task });
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
					workflowRunRepo.updateStatus(task.workflowRunId, 'cancelled');
					return jsonResult({
						success: true,
						task,
						workflowRunCancelled: true,
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
			'Show all workflows in this space with their descriptions and steps. Call this first to understand available options before starting a run.',
			{},
			() => handlers.list_workflows()
		),
		tool(
			'start_workflow_run',
			'Begin a workflow run. You must call list_workflows first and choose the workflow whose description and steps best match the request.',
			{
				workflow_id: z
					.string()
					.describe('ID of the workflow to run (required — choose from list_workflows)'),
				title: z.string().describe('Short title for this workflow run'),
				description: z.string().optional().describe('Detailed description of the work to be done'),
			},
			(args) => handlers.start_workflow_run(args)
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
			'Get the full definition of a specific workflow, including all steps, transitions, and rules. Use this to inspect a candidate workflow before starting a run.',
			{
				workflow_id: z.string().describe('ID of the workflow to retrieve'),
			},
			(args) => handlers.get_workflow_detail(args)
		),
		tool(
			'suggest_workflow',
			'Get workflow recommendations for a described piece of work. Returns workflows ranked by keyword relevance against names, descriptions, and tags. Use this to narrow candidates before calling start_workflow_run.',
			{
				description: z
					.string()
					.describe('Description of the work you want to do — used for keyword matching'),
			},
			(args) => handlers.suggest_workflow(args)
		),
		tool(
			'list_tasks',
			'List SpaceTasks for this space. Optionally filter by status or by a specific workflow run.',
			{
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
					])
					.optional()
					.describe('Filter by task status'),
				workflow_run_id: z
					.string()
					.optional()
					.describe('Filter to only tasks belonging to a specific workflow run'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'create_standalone_task',
			'Create a standalone task not associated with any workflow run. Use this to assign ad-hoc work directly to an agent.',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed description of the work to be done'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Task priority (default: normal)'),
				task_type: z
					.enum(['planning', 'coding', 'research', 'design', 'review'])
					.optional()
					.describe('Task type — determines default execution approach'),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Agent type to execute this task (default: coder)'),
				custom_agent_id: z
					.string()
					.optional()
					.describe('ID of a custom Space agent to assign this task to'),
				goal_id: z
					.string()
					.optional()
					.describe(
						'ID of the goal this task is associated with. When all tasks for a goal complete, ' +
							'SpaceRuntime automatically notifies the Space Agent to verify and close the goal loop.'
					),
			},
			(args) => handlers.create_standalone_task(args)
		),
		tool(
			'complete_goal',
			'Mark a goal as successfully completed after verification confirms all tasks passed validation. ' +
				'Call this only after a verification task confirms the work meets the goal criteria.',
			{
				goal_id: z.string().describe('ID of the goal to mark as completed'),
				summary: z
					.string()
					.describe(
						'Summary of what was accomplished and how it meets the goal validation criteria'
					),
			},
			(args) => handlers.complete_goal(args)
		),
		tool(
			'get_task_detail',
			'Get the full detail of a task by ID, including error, result, PR URL, PR number, progress, and current step.',
			{
				task_id: z.string().describe('ID of the task to retrieve'),
			},
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'retry_task',
			'Retry a failed (needs_attention) or cancelled task by resetting it to pending. Optionally provide an updated description.',
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
			'Change the agent assignment for a task. Only allowed for tasks in pending, needs_attention, or cancelled status.',
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
	];

	return createSdkMcpServer({ name: 'space-agent', tools });
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
