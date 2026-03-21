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
import type {
	SpaceTaskStatus,
	SpaceAutonomyLevel,
	CreateSpaceParams,
	UpdateSpaceParams,
} from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';

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

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Common English stop words filtered out by suggest_workflow before keyword matching.
 */
const SUGGEST_WORKFLOW_STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'are',
	'but',
	'not',
	'you',
	'all',
	'can',
	'her',
	'was',
	'one',
	'our',
	'out',
	'day',
	'get',
	'has',
	'him',
	'his',
	'how',
	'its',
	'may',
	'new',
	'now',
	'old',
	'see',
	'two',
	'use',
	'way',
	'who',
	'did',
	'let',
	'put',
	'say',
	'she',
	'too',
	'had',
	'any',
	'via',
]);

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 */
export function createGlobalSpacesToolHandlers(
	config: GlobalSpacesToolsConfig,
	state: GlobalSpacesState
) {
	const { spaceManager, spaceAgentManager, runtime, workflowManager, taskRepo, workflowRunRepo } =
		config;

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
			'Update space metadata (name, description, instructions, etc.).',
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
					.describe('New autonomy level for the Space Agent'),
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
	];

	return createSdkMcpServer({ name: 'global-spaces-tools', tools });
}
