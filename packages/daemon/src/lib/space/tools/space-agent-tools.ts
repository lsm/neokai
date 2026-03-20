/**
 * Space Agent Tools — MCP tools for the Space leader agent session.
 *
 * These tools allow the Space agent to start workflow runs, check status,
 * change plans, and query Space tasks. They are in the Space namespace (not Room).
 *
 * Tools (per M7 spec):
 *   list_workflows     — show all workflows with their descriptions and steps
 *   start_workflow_run — begin a workflow run (requires explicit workflowId)
 *   get_workflow_run   — check the status of a running workflow
 *   change_plan        — update task description or switch to a different workflow mid-run
 *   list_tasks         — see current and past tasks
 *
 * Design note: workflow selection is LLM-driven. The agent calls list_workflows,
 * reasons about which workflow fits the request, then calls start_workflow_run
 * with an explicit workflowId. There are no server-side heuristics.
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceTaskStatus } from '@neokai/shared';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';

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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 * Returns a map of tool name → handler function.
 */
export function createSpaceAgentToolHandlers(config: SpaceAgentToolsConfig) {
	const { spaceId, runtime, workflowManager, taskRepo, workflowRunRepo } = config;

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
	];

	return createSdkMcpServer({ name: 'space-agent', tools });
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
