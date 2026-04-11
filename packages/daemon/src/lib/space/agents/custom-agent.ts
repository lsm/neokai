/**
 * Custom Agent Factory
 *
 * Creates `AgentSessionInit` from a visible `SpaceAgent` + workflow slot configuration.
 * Runtime behavior must be WYSIWYG: code provides structure and context, while agent
 * behavior comes only from visible prompt fields on the agent or workflow node.
 */

import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	AgentDefinition,
	McpServerConfig,
	RoomSkillOverride,
	Space,
	SpaceAgent,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { SUB_SESSION_FEATURES } from './seed-agents';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Per-slot overrides from a `WorkflowNodeAgent` entry.
 * Applied on top of the base `SpaceAgent` config when spawning a specific slot.
 *
 * Semantics:
 * - `customPrompt` is always appended (expanded) after the agent's `customPrompt`.
 *   It cannot replace the base prompt — the NeoKai contract sections remain intact.
 * - absent (undefined) — uses the agent's base value unchanged.
 */
export interface SlotOverrides {
	/** Override the agent's default model for this slot */
	model?: string;
	/** Expansion text appended to the agent's customPrompt for this slot */
	customPrompt?: string;
	/** IDs of globally-enabled skills to disable for this slot */
	disabledSkillIds?: string[];
	/** Extra MCP servers to add for this slot */
	extraMcpServers?: Record<string, McpServerConfig>;
}

/**
 * Append-only prompt composition: returns `base` + `\n\n` + `expansion`.
 *
 * - If `expansion` is absent/empty, returns `base` unchanged.
 * - If `base` is absent/empty, returns `expansion`.
 * - Both present: joined with a double newline.
 */
export function expandPrompt(
	base: string | null | undefined,
	expansion: string | null | undefined
): string {
	const trimmedBase = base?.trim() ?? '';
	const trimmedExpansion = expansion?.trim() ?? '';
	if (!trimmedExpansion) return trimmedBase;
	if (!trimmedBase) return trimmedExpansion;
	return `${trimmedBase}\n\n${trimmedExpansion}`;
}

export interface CustomAgentConfig {
	/** The Space agent definition */
	customAgent: SpaceAgent;
	/** The task being executed */
	task: SpaceTask;
	/** The workflow run context (null when running outside a workflow) */
	workflowRun: SpaceWorkflowRun | null;
	/** Full workflow definition for factual runtime context */
	workflow?: SpaceWorkflow | null;
	/** The Space this agent belongs to */
	space: Space;
	/** Session ID for the new session */
	sessionId: string;
	/** Workspace path (typically `space.workspacePath`) */
	workspacePath: string;
	/** Summaries of previously completed tasks for context */
	previousTaskSummaries?: string[];
	/** Optional per-slot workflow overrides */
	slotOverrides?: SlotOverrides;
}

/**
 * Build the runtime system prompt text for a custom agent.
 *
 * The NeoKai system contract (tool rules, completion semantics) is applied first by the
 * SDK preset; then the agent's `customPrompt` is appended, followed by any slot expansion.
 * User content always comes after the contract and cannot override it.
 */
export function buildCustomAgentSystemPrompt(
	customAgent: SpaceAgent,
	slotOverrides?: SlotOverrides
): string {
	return expandPrompt(customAgent.customPrompt, slotOverrides?.customPrompt);
}

/**
 * Build the initial user message for a custom agent session.
 *
 * Contains factual task/workflow/space context only.
 * Behavioral prompt (persona, operating procedure) lives in the system prompt.
 */
export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
	const { task, workflowRun, workflow, space, previousTaskSummaries } = config;

	const sections: string[] = [];

	sections.push(`## Task #${task.taskNumber}\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) sections.push(`**Priority:** ${task.priority}`);

	if (workflowRun) {
		sections.push(`\n## Workflow Context\n`);
		sections.push(`**Workflow Run:** ${workflowRun.title}`);
		if (workflowRun.description) {
			sections.push(`**Description:** ${workflowRun.description}`);
		}
	}

	if (workflow && workflowRun) {
		sections.push(`\n## Workflow Structure\n`);
		sections.push(`**Workflow:** ${workflow.name}`);
		if (workflow.description) {
			sections.push(`**Workflow Description:** ${workflow.description}`);
		}

		if (workflow.nodes.length > 0) {
			sections.push(`\n**Nodes:**`);
			for (const node of workflow.nodes) {
				sections.push(`- **${node.name}** (id: \`${node.id}\`)`);
			}
		}
	}

	if (task.prUrl) {
		sections.push(`\n## Existing Pull Request\n`);
		sections.push(`**PR URL:** ${task.prUrl}`);
	}

	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push(`\n## Previous Work on This Goal\n`);
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	if (space.backgroundContext) {
		sections.push(`\n## Project Context\n`);
		sections.push(space.backgroundContext);
	}

	if (space.instructions) {
		sections.push(`\n## Space Instructions\n`);
		sections.push(space.instructions);
	}

	if (workflow?.instructions) {
		sections.push(`\n## Workflow Instructions\n`);
		sections.push(workflow.instructions);
	}

	return sections.join('\n');
}

/**
 * Create an `AgentSessionInit` for a Space agent session.
 *
 * Workflow execution is WYSIWYG:
 * - inside a workflow run, the workflow slot customPrompt is expanded on top of the agent's
 * - outside a workflow run, the agent's own `customPrompt` is used unchanged
 *
 * The NeoKai system contract (preset) is always applied first; user content follows.
 */
export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
	const { customAgent, space, sessionId, workspacePath, slotOverrides } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;
	const model =
		slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	const visiblePrompt = buildCustomAgentSystemPrompt(customAgent, slotOverrides);

	const roomSkillOverrides: RoomSkillOverride[] | undefined = slotOverrides?.disabledSkillIds
		?.length
		? slotOverrides.disabledSkillIds.map((id) => ({ skillId: id, roomId: '', enabled: false }))
		: undefined;

	const extraMcpServers = slotOverrides?.extraMcpServers;

	if (customTools) {
		const agentKey = sanitizeAgentKey(customAgent.name);
		const agentDef: AgentDefinition = {
			description: customAgent.description ?? `Custom agent: ${customAgent.name}`,
			tools: customTools,
			model: 'inherit',
			prompt: visiblePrompt,
		};

		return {
			sessionId,
			workspacePath,
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
			},
			features: SUB_SESSION_FEATURES,
			context: { spaceId: space.id },
			type: 'worker',
			model,
			provider,
			agent: agentKey,
			agents: { [agentKey]: agentDef },
			contextAutoQueue: false,
			roomSkillOverrides,
			mcpServers: extraMcpServers,
		};
	}

	return {
		sessionId,
		workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: visiblePrompt,
		},
		features: SUB_SESSION_FEATURES,
		context: { spaceId: space.id },
		type: 'worker',
		model,
		provider,
		contextAutoQueue: false,
		roomSkillOverrides,
		mcpServers: extraMcpServers,
	};
}

export interface ResolveAgentInitConfig {
	/** The task to execute */
	task: SpaceTask;
	/** The Space this task belongs to */
	space: Space;
	/** Agent manager for resolving agents */
	agentManager: SpaceAgentManager;
	/** Session ID for the new session */
	sessionId: string;
	/** Workspace path */
	workspacePath: string;
	/** Workflow run context (null when outside a workflow) */
	workflowRun?: SpaceWorkflowRun | null;
	/** Full workflow definition for factual runtime context */
	workflow?: SpaceWorkflow | null;
	/** Summaries of previously completed tasks */
	previousTaskSummaries?: string[];
	/** Optional per-slot workflow overrides */
	slotOverrides?: SlotOverrides;
	/**
	 * Explicit agent ID to use for this session.
	 * Required since SpaceTask no longer stores customAgentId directly.
	 */
	agentId: string;
}

/**
 * Resolve the session init for a Space task by loading its assigned `SpaceAgent`.
 */
export function resolveAgentInit(config: ResolveAgentInitConfig): AgentSessionInit {
	const {
		task,
		space,
		agentManager,
		sessionId,
		workspacePath,
		workflowRun,
		workflow,
		previousTaskSummaries,
		slotOverrides,
		agentId,
	} = config;

	const agent = agentManager.getById(agentId);
	if (!agent) {
		throw new Error(`Agent not found: ${agentId} (task: ${task.id})`);
	}

	return createCustomAgentInit({
		customAgent: agent,
		task,
		workflowRun: workflowRun ?? null,
		workflow: workflow ?? null,
		space,
		sessionId,
		workspacePath,
		previousTaskSummaries,
		slotOverrides,
	});
}

function sanitizeAgentKey(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'custom-agent'
	);
}
