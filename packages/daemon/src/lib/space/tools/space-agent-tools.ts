/**
 * Space Agent Tools — MCP tools for the Space leader agent session.
 *
 * These tools allow the Space agent to start workflow runs, create standalone
 * tasks, and query Space state. They are in the Space namespace (not Room).
 *
 * Tools:
 *   start_workflow_run — starts a run with optional workflowId (auto-selects if omitted)
 *   create_task        — creates a standalone SpaceTask (no workflow)
 *   list_workflows     — returns available SpaceWorkflow records for the space
 *   list_tasks         — filterable by status and workflowRunId
 *   list_workflow_runs — returns active/completed runs for the space
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceTaskStatus, SpaceTaskType, SpaceTaskPriority } from '@neokai/shared';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import { selectWorkflow } from '../runtime/workflow-selector';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceAgentToolsConfig {
	/** The Space this agent is operating within. */
	spaceId: string;
	/** SpaceRuntime for starting workflow runs. */
	runtime: SpaceRuntime;
	/** Workflow manager for listing available workflows. */
	workflowManager: SpaceWorkflowManager;
	/** Task repository for read queries (list/filter). */
	taskRepo: SpaceTaskRepository;
	/** Workflow run repository for listing runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task manager for creating standalone tasks. */
	taskManager: SpaceTaskManager;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: Record<string, unknown>): ToolResult {
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
	const { spaceId, runtime, workflowManager, taskRepo, workflowRunRepo, taskManager } = config;

	return {
		/**
		 * Start a new workflow run.
		 * If workflowId is not provided, auto-selects a workflow via selectWorkflow().
		 * Falls back to null (standalone task) if no workflow matches.
		 */
		async start_workflow_run(args: {
			title: string;
			description?: string;
			workflow_id?: string;
		}): Promise<ToolResult> {
			const availableWorkflows = workflowManager.listWorkflows(spaceId);

			const selected = selectWorkflow({
				spaceId,
				title: args.title,
				description: args.description ?? '',
				availableWorkflows,
				workflowId: args.workflow_id,
			});

			if (!selected) {
				return jsonResult({
					success: false,
					error:
						'No matching workflow found. Use create_task to create a standalone task instead, or provide an explicit workflow_id.',
					availableWorkflows: availableWorkflows.map((w) => ({ id: w.id, name: w.name })),
				});
			}

			try {
				const { run, tasks } = await runtime.startWorkflowRun(
					spaceId,
					selected.id,
					args.title,
					args.description
				);
				return jsonResult({ success: true, run, tasks, selectedWorkflowId: selected.id });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Create a standalone SpaceTask (not associated with a workflow run).
		 */
		async create_task(args: {
			title: string;
			description: string;
			task_type?: SpaceTaskType;
			custom_agent_id?: string;
			priority?: SpaceTaskPriority;
			depends_on?: string[];
		}): Promise<ToolResult> {
			try {
				const task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					taskType: args.task_type,
					customAgentId: args.custom_agent_id,
					priority: args.priority,
					dependsOn: args.depends_on,
					status: 'pending',
				});
				return jsonResult({ success: true, taskId: task.id, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List all available SpaceWorkflow records for this space.
		 */
		async list_workflows(): Promise<ToolResult> {
			const workflows = workflowManager.listWorkflows(spaceId);
			return jsonResult({ success: true, workflows });
		},

		/**
		 * List SpaceTasks, optionally filtered by status and/or workflowRunId.
		 * When workflowRunId is provided, returns only tasks belonging to that run.
		 * When status is provided, filters by task status.
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
		 * List workflow runs for this space.
		 * By default returns all runs; optionally filter by status.
		 */
		async list_workflow_runs(args: { status?: string }): Promise<ToolResult> {
			let runs = workflowRunRepo.listBySpace(spaceId);
			if (args.status) {
				runs = runs.filter((r) => r.status === args.status);
			}
			return jsonResult({ success: true, runs });
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
			'start_workflow_run',
			'Start a new workflow run for the space. Auto-selects the best workflow if workflow_id is not provided.',
			{
				title: z.string().describe('Short title for this workflow run'),
				description: z
					.string()
					.optional()
					.describe(
						'Detailed description of the work. Used for workflow auto-selection when workflow_id is omitted.'
					),
				workflow_id: z
					.string()
					.optional()
					.describe(
						'Explicit workflow ID to use. When omitted, a workflow is auto-selected based on title/description.'
					),
			},
			(args) => handlers.start_workflow_run(args)
		),
		tool(
			'create_task',
			'Create a standalone SpaceTask not associated with any workflow run.',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed task description and acceptance criteria'),
				task_type: z
					.enum(['planning', 'coding', 'research', 'design', 'review'])
					.optional()
					.describe('Task type — determines which agent preset runs this task'),
				custom_agent_id: z
					.string()
					.optional()
					.describe('ID of a custom SpaceAgent to run this task'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Task priority'),
				depends_on: z
					.array(z.string())
					.optional()
					.describe('IDs of tasks that must complete before this task starts'),
			},
			(args) => handlers.create_task(args)
		),
		tool(
			'list_workflows',
			'List all available workflows for this space, including their names, descriptions, and tags.',
			{},
			() => handlers.list_workflows()
		),
		tool(
			'list_tasks',
			'List SpaceTasks for this space. Optionally filter by status or workflow run.',
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
			'list_workflow_runs',
			'List workflow runs for this space. Optionally filter by status.',
			{
				status: z
					.enum(['pending', 'in_progress', 'completed', 'cancelled', 'needs_attention'])
					.optional()
					.describe('Filter by run status'),
			},
			(args) => handlers.list_workflow_runs(args)
		),
	];

	return createSdkMcpServer({ name: 'space-agent', tools });
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
