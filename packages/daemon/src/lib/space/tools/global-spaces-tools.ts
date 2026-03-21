/**
 * Global Spaces Tools — MCP tools for the cross-space Global Spaces Agent.
 *
 * Combines two categories of tools:
 *   1. Cross-space tools: manage spaces (CRUD)
 *   2. Per-space tools: manage workflows, tasks, and agents within a space
 *      These use the activeSpaceId from shared state, or an explicit spaceId param.
 *
 * Design follows the two-layer pattern from space-agent-tools.ts:
 *   - createGlobalSpacesToolHandlers(config) → testable handler functions
 *   - createGlobalSpacesMcpServer(config) → MCP server wrapping handlers
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	SpaceTaskStatus,
	SpaceAutonomyLevel,
	CreateSpaceParams,
	UpdateSpaceParams,
	SpaceTaskPriority,
	SpaceTaskType,
} from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { jsonResult, SUGGEST_WORKFLOW_STOP_WORDS } from './tool-result';
import type { ToolResult } from './tool-result';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GlobalSpacesToolsConfig {
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
	workflowManager: SpaceWorkflowManager;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Database instance used to create SpaceTaskManager instances on demand. */
	db: BunDatabase;
}

/**
 * Shared mutable state for the active space context.
 * Updated when the user clicks a space card in the UI.
 */
export interface GlobalSpacesState {
	activeSpaceId: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Canonical list of valid autonomy level values.
 * Used by both MCP tool zod schemas so there is a single source of truth.
 * Must be kept in sync with the `SpaceAutonomyLevel` type in @neokai/shared.
 */
const AUTONOMY_LEVEL_VALUES = [
	'supervised',
	'semi_autonomous',
] as const satisfies readonly SpaceAutonomyLevel[];
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 */
export function createGlobalSpacesToolHandlers(
	config: GlobalSpacesToolsConfig,
	state: GlobalSpacesState
) {
	const {
		spaceManager,
		spaceAgentManager,
		runtime,
		workflowManager,
		taskRepo,
		workflowRunRepo,
		db,
	} = config;

	/**
	 * Cache of SpaceTaskManager instances keyed by spaceId.
	 * Follows the same getOrCreate pattern as SpaceRuntime.getOrCreateTaskManager().
	 * Lifecycle: the cache is created once per createGlobalSpacesToolHandlers() call.
	 * In practice createGlobalSpacesMcpServer() calls this exactly once per provisioning,
	 * so there is no cross-call state sharing to worry about.
	 */
	const taskManagers = new Map<string, SpaceTaskManager>();

	function getOrCreateTaskManager(spaceId: string): SpaceTaskManager {
		let mgr = taskManagers.get(spaceId);
		if (!mgr) {
			mgr = new SpaceTaskManager(db, spaceId);
			taskManagers.set(spaceId, mgr);
		}
		return mgr;
	}

	/**
	 * Resolve the spaceId for per-space tools.
	 * Uses explicit spaceId if provided, otherwise falls back to activeSpaceId.
	 */
	function resolveSpaceId(explicitSpaceId?: string): { spaceId: string } | { error: string } {
		if (explicitSpaceId) return { spaceId: explicitSpaceId };
		if (state.activeSpaceId) return { spaceId: state.activeSpaceId };
		return {
			error:
				'No space specified. Provide a space_id, or click a space card in the UI to set the active space context.',
		};
	}

	return {
		// ---- Cross-space tools ----

		async list_spaces(args?: { include_archived?: boolean }): Promise<ToolResult> {
			const spaces = spaceManager.listSpaces(args?.include_archived ?? false);
			return jsonResult({ success: true, spaces });
		},

		async create_space(args: {
			name: string;
			workspace_path: string;
			description?: string;
			instructions?: string;
			autonomy_level?: SpaceAutonomyLevel;
		}): Promise<ToolResult> {
			try {
				const params: CreateSpaceParams = {
					name: args.name,
					workspacePath: args.workspace_path,
					description: args.description,
					instructions: args.instructions,
					autonomyLevel: args.autonomy_level,
				};
				const space = await spaceManager.createSpace(params);
				return jsonResult({ success: true, space });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async get_space(args: { space_id: string }): Promise<ToolResult> {
			const space = spaceManager.getSpace(args.space_id);
			if (!space) {
				return jsonResult({ success: false, error: `Space not found: ${args.space_id}` });
			}
			const agents = spaceAgentManager.listBySpaceId(args.space_id);
			return jsonResult({ success: true, space, agents });
		},

		async update_space(args: {
			space_id: string;
			name?: string;
			description?: string;
			instructions?: string;
			background_context?: string;
			default_model?: string;
			autonomy_level?: SpaceAutonomyLevel;
		}): Promise<ToolResult> {
			try {
				const params: UpdateSpaceParams = {};
				if (args.name !== undefined) params.name = args.name;
				if (args.description !== undefined) params.description = args.description;
				if (args.instructions !== undefined) params.instructions = args.instructions;
				if (args.background_context !== undefined)
					params.backgroundContext = args.background_context;
				if (args.default_model !== undefined) params.defaultModel = args.default_model;
				if (args.autonomy_level !== undefined) params.autonomyLevel = args.autonomy_level;
				const space = await spaceManager.updateSpace(args.space_id, params);
				return jsonResult({ success: true, space });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async archive_space(args: { space_id: string }): Promise<ToolResult> {
			try {
				const space = await spaceManager.archiveSpace(args.space_id);
				return jsonResult({ success: true, space });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async delete_space(args: { space_id: string }): Promise<ToolResult> {
			try {
				const deleted = await spaceManager.deleteSpace(args.space_id);
				return jsonResult({ success: true, deleted });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		// ---- Per-space tools (use activeSpaceId or explicit space_id) ----

		async list_workflows(args?: { space_id?: string }): Promise<ToolResult> {
			const resolved = resolveSpaceId(args?.space_id);
			if ('error' in resolved) return jsonResult({ success: false, error: resolved.error });
			const workflows = workflowManager.listWorkflows(resolved.spaceId);
			return jsonResult({ success: true, space_id: resolved.spaceId, workflows });
		},

		async get_workflow_detail(args: { workflow_id: string }): Promise<ToolResult> {
			const workflow = workflowManager.getWorkflow(args.workflow_id);
			if (!workflow) {
				return jsonResult({ success: false, error: `Workflow not found: ${args.workflow_id}` });
			}
			return jsonResult({ success: true, workflow });
		},

		async start_workflow_run(args: {
			space_id?: string;
			workflow_id: string;
			title: string;
			description?: string;
		}): Promise<ToolResult> {
			const resolved = resolveSpaceId(args.space_id);
			if ('error' in resolved) return jsonResult({ success: false, error: resolved.error });
			try {
				const { run, tasks } = await runtime.startWorkflowRun(
					resolved.spaceId,
					args.workflow_id,
					args.title,
					args.description
				);
				return jsonResult({ success: true, space_id: resolved.spaceId, run, tasks });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async get_workflow_run(args: { run_id: string }): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}
			let currentStep = null;
			if (run.currentStepId) {
				const workflow = workflowManager.getWorkflow(run.workflowId);
				if (workflow) {
					currentStep = workflow.steps.find((s) => s.id === run.currentStepId) ?? null;
				}
			}
			const tasks = taskRepo.listByWorkflowRun(run.id);
			return jsonResult({ success: true, run, currentStep, tasks });
		},

		async list_tasks(args?: {
			space_id?: string;
			status?: SpaceTaskStatus;
			workflow_run_id?: string;
		}): Promise<ToolResult> {
			const resolved = resolveSpaceId(args?.space_id);
			if ('error' in resolved) return jsonResult({ success: false, error: resolved.error });
			let tasks;
			if (args?.workflow_run_id) {
				tasks = taskRepo.listByWorkflowRun(args.workflow_run_id);
				if (args.status) {
					tasks = tasks.filter((t) => t.status === args.status);
				}
			} else if (args?.status) {
				tasks = taskRepo.listByStatus(resolved.spaceId, args.status);
			} else {
				tasks = taskRepo.listBySpace(resolved.spaceId);
			}
			return jsonResult({ success: true, space_id: resolved.spaceId, tasks });
		},

		async suggest_workflow(args: { space_id?: string; description: string }): Promise<ToolResult> {
			const resolved = resolveSpaceId(args.space_id);
			if ('error' in resolved) return jsonResult({ success: false, error: resolved.error });
			const allWorkflows = workflowManager.listWorkflows(resolved.spaceId);
			if (allWorkflows.length === 0) {
				return jsonResult({
					success: true,
					space_id: resolved.spaceId,
					workflows: [],
					message: 'No workflows available in this space.',
				});
			}
			const keywords = args.description
				.toLowerCase()
				.split(/\W+/)
				.filter((w) => w.length >= 3 && !SUGGEST_WORKFLOW_STOP_WORDS.has(w));
			if (keywords.length === 0) {
				return jsonResult({ success: true, space_id: resolved.spaceId, workflows: allWorkflows });
			}
			const scored = allWorkflows.map((wf) => {
				const haystack = [wf.name, wf.description ?? '', ...(wf.tags ?? [])]
					.join(' ')
					.toLowerCase();
				const hits = keywords.filter((kw) => haystack.includes(kw)).length;
				return { workflow: wf, hits };
			});
			scored.sort((a, b) => b.hits - a.hits);
			return jsonResult({
				success: true,
				space_id: resolved.spaceId,
				workflows: scored.map((s) => s.workflow),
			});
		},

		// ---- Coordination tools ----

		async create_standalone_task(args: {
			space_id?: string;
			title: string;
			description: string;
			priority?: SpaceTaskPriority;
			task_type?: SpaceTaskType;
			assigned_agent?: 'coder' | 'general';
			custom_agent_id?: string;
			depends_on?: string[];
		}): Promise<ToolResult> {
			const resolved = resolveSpaceId(args.space_id);
			if ('error' in resolved) return jsonResult({ success: false, error: resolved.error });
			try {
				const mgr = getOrCreateTaskManager(resolved.spaceId);
				const task = await mgr.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					taskType: args.task_type,
					assignedAgent: args.assigned_agent,
					customAgentId: args.custom_agent_id,
					dependsOn: args.depends_on,
				});
				return jsonResult({ success: true, space_id: resolved.spaceId, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async get_task_detail(args: { task_id: string; space_id?: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			// Space ownership validation: when a space context is available (explicit space_id or
			// activeSpaceId), reject cross-space access. When no context is available the Global
			// Agent is operating cross-space and the check is intentionally skipped — task IDs are
			// globally unique UUIDs and the Global Agent is trusted to use them responsibly.
			const resolved = resolveSpaceId(args.space_id);
			if ('spaceId' in resolved && task.spaceId !== resolved.spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to space ${resolved.spaceId}`,
				});
			}
			return jsonResult({ success: true, task });
		},

		async retry_task(args: {
			task_id: string;
			space_id?: string;
			description?: string;
		}): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			// Space ownership validation: when a context is available, enforce it. When absent,
			// the Global Agent is operating cross-space and the check is intentionally skipped.
			const resolved = resolveSpaceId(args.space_id);
			if ('spaceId' in resolved && task.spaceId !== resolved.spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to space ${resolved.spaceId}`,
				});
			}
			try {
				const mgr = getOrCreateTaskManager(task.spaceId);
				const retried = await mgr.retryTask(args.task_id, { description: args.description });
				return jsonResult({ success: true, task: retried });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async cancel_task(args: {
			task_id: string;
			space_id?: string;
			cancel_workflow_run?: boolean;
		}): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			// Space ownership validation: when a context is available, enforce it. When absent,
			// the Global Agent is operating cross-space and the check is intentionally skipped.
			const resolved = resolveSpaceId(args.space_id);
			if ('spaceId' in resolved && task.spaceId !== resolved.spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to space ${resolved.spaceId}`,
				});
			}
			try {
				const mgr = getOrCreateTaskManager(task.spaceId);
				const cancelled = await mgr.cancelTask(args.task_id);
				let cancelledRun = null;
				if (args.cancel_workflow_run && task.workflowRunId) {
					// Guard against stale run IDs: updateStatus returns null when the run is
					// not found, which would leave the task cancelled but the run untouched.
					const updatedRun = workflowRunRepo.updateStatus(task.workflowRunId, 'cancelled');
					if (updatedRun) {
						cancelledRun = task.workflowRunId;
					}
				}
				return jsonResult({ success: true, task: cancelled, cancelledWorkflowRunId: cancelledRun });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async reassign_task(args: {
			task_id: string;
			space_id?: string;
			custom_agent_id: string | null;
			assigned_agent?: 'coder' | 'general';
		}): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			// Space ownership validation: when a context is available, enforce it. When absent,
			// the Global Agent is operating cross-space and the check is intentionally skipped.
			const resolved = resolveSpaceId(args.space_id);
			if ('spaceId' in resolved && task.spaceId !== resolved.spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to space ${resolved.spaceId}`,
				});
			}
			try {
				const mgr = getOrCreateTaskManager(task.spaceId);
				const reassigned = await mgr.reassignTask(
					args.task_id,
					args.custom_agent_id,
					args.assigned_agent
				);
				return jsonResult({ success: true, task: reassigned });
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
 * Create an MCP server exposing all Global Spaces Agent tools.
 * Pass the returned server to the SDK session init.
 */
export function createGlobalSpacesMcpServer(
	config: GlobalSpacesToolsConfig,
	state: GlobalSpacesState
) {
	const handlers = createGlobalSpacesToolHandlers(config, state);

	const tools = [
		// Cross-space tools
		tool(
			'list_spaces',
			'List all spaces. Optionally include archived spaces.',
			{
				include_archived: z.boolean().optional().describe('Include archived spaces in the results'),
			},
			(args) => handlers.list_spaces(args)
		),
		tool(
			'create_space',
			'Create a new space with a name and workspace path.',
			{
				name: z.string().describe('Name for the new space'),
				workspace_path: z.string().describe('Absolute path to the workspace directory'),
				description: z.string().optional().describe('Description of the space'),
				instructions: z
					.string()
					.optional()
					.describe('Instructions for agents working in this space'),
				autonomy_level: z
					.enum(AUTONOMY_LEVEL_VALUES)
					.optional()
					.describe(
						'Autonomy level for the Space Agent. "supervised" (default): agent notifies human of all judgment-required events and waits for approval. "semi_autonomous": agent can retry failed tasks and reassign them autonomously.'
					),
			},
			(args) => handlers.create_space(args)
		),
		tool(
			'get_space',
			'Get details of a specific space including its agents.',
			{
				space_id: z.string().describe('ID of the space to retrieve'),
			},
			(args) => handlers.get_space(args)
		),
		tool(
			'update_space',
			'Update space metadata (name, description, instructions, autonomy level, etc.).',
			{
				space_id: z.string().describe('ID of the space to update'),
				name: z.string().optional().describe('New name'),
				description: z.string().optional().describe('New description'),
				instructions: z.string().optional().describe('New instructions for agents'),
				background_context: z.string().optional().describe('New background context'),
				default_model: z.string().optional().describe('New default model ID'),
				autonomy_level: z
					.enum(AUTONOMY_LEVEL_VALUES)
					.optional()
					.describe(
						'Autonomy level for the Space Agent: supervised (ask human before acting) or semi_autonomous (act on simple cases, escalate when uncertain)'
					),
			},
			(args) => handlers.update_space(args)
		),
		tool(
			'archive_space',
			'Archive a space (soft delete). The space can be restored later.',
			{
				space_id: z.string().describe('ID of the space to archive'),
			},
			(args) => handlers.archive_space(args)
		),
		tool(
			'delete_space',
			'Permanently delete a space and all its data. This cannot be undone.',
			{
				space_id: z.string().describe('ID of the space to delete'),
			},
			(args) => handlers.delete_space(args)
		),

		// Per-space tools
		tool(
			'list_workflows',
			'Show all workflows in a space. Uses the active space context unless space_id is provided.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
			},
			(args) => handlers.list_workflows(args)
		),
		tool(
			'get_workflow_detail',
			'Get the full definition of a workflow including steps, transitions, and rules.',
			{
				workflow_id: z.string().describe('ID of the workflow'),
			},
			(args) => handlers.get_workflow_detail(args)
		),
		tool(
			'start_workflow_run',
			'Begin a workflow run in a space. Call list_workflows first to pick the right workflow.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
				workflow_id: z.string().describe('ID of the workflow to run'),
				title: z.string().describe('Short title for this workflow run'),
				description: z.string().optional().describe('Description of the work'),
			},
			(args) => handlers.start_workflow_run(args)
		),
		tool(
			'get_workflow_run',
			'Check the status of a workflow run including current step and associated tasks.',
			{
				run_id: z.string().describe('ID of the workflow run'),
			},
			(args) => handlers.get_workflow_run(args)
		),
		tool(
			'list_tasks',
			'List tasks in a space. Optionally filter by status or workflow run.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
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
				workflow_run_id: z.string().optional().describe('Filter by workflow run ID'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'suggest_workflow',
			'Get workflow recommendations for a described piece of work. Returns workflows ranked by relevance.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
				description: z
					.string()
					.describe('Description of the work to match against workflow names and descriptions'),
			},
			(args) => handlers.suggest_workflow(args)
		),

		// Coordination tools
		tool(
			'create_standalone_task',
			'Create a task outside any workflow. Use this to spin up ad-hoc work that does not belong to an existing workflow run.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed description of the work to be done'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Task priority (default: normal)'),
				task_type: z
					.enum(['planning', 'coding', 'research', 'design', 'review'])
					.optional()
					.describe('Task type for routing and display'),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Built-in agent type to assign (default: coder)'),
				custom_agent_id: z
					.string()
					.optional()
					.describe('Custom Space agent ID to assign instead of the built-in agent'),
				depends_on: z
					.array(z.string())
					.optional()
					.describe('IDs of tasks that must complete before this task can start'),
			},
			(args) => handlers.create_standalone_task(args)
		),
		tool(
			'get_task_detail',
			'Get the full detail of a task including agent output, PR status, and error info. Task IDs are globally unique.',
			{
				task_id: z.string().describe('ID of the task to retrieve'),
				space_id: z
					.string()
					.optional()
					.describe(
						'Space ID to validate ownership against (defaults to the active space context; omit to skip validation)'
					),
			},
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'retry_task',
			'Reset a failed (needs_attention) or cancelled task back to pending so it can be picked up again. Optionally update the description before retry.',
			{
				task_id: z.string().describe('ID of the task to retry'),
				space_id: z
					.string()
					.optional()
					.describe('Space ID to validate ownership (defaults to active space context)'),
				description: z.string().optional().describe('Updated task description to use on retry'),
			},
			(args) => handlers.retry_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task. Pending tasks that depend on this task are also cancelled (cascade). Optionally cancel the associated workflow run.',
			{
				task_id: z.string().describe('ID of the task to cancel'),
				space_id: z
					.string()
					.optional()
					.describe('Space ID to validate ownership (defaults to active space context)'),
				cancel_workflow_run: z
					.boolean()
					.optional()
					.describe(
						'If true and the task belongs to a workflow run, cancel that run as well (default: false)'
					),
			},
			(args) => handlers.cancel_task(args)
		),
		tool(
			'reassign_task',
			'Change the agent assigned to a task. Only allowed for tasks in pending, needs_attention, or cancelled status.',
			{
				task_id: z.string().describe('ID of the task to reassign'),
				space_id: z
					.string()
					.optional()
					.describe('Space ID to validate ownership (defaults to active space context)'),
				custom_agent_id: z
					.string()
					.nullable()
					.describe('Custom Space agent ID to assign, or null to revert to the built-in agent'),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Built-in agent type (used when custom_agent_id is null)'),
			},
			(args) => handlers.reassign_task(args)
		),
	];

	return createSdkMcpServer({ name: 'global-spaces-tools', tools });
}
