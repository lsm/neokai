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
	Space,
	SpaceAgent,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	WorkflowNodeAgentOverride,
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { SUB_SESSION_FEATURES } from './seed-agents';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Per-slot overrides from a `WorkflowNodeAgent` entry.
 * Applied on top of the base `SpaceAgent` config when spawning a specific slot.
 *
 * Override semantics:
 * - `mode: 'override'` — replaces the agent's base value entirely.
 * - `mode: 'expand'`   — appends the value to the agent's base (joined with `\n\n`).
 * - absent (undefined) — uses the agent's base value unchanged.
 */
export interface SlotOverrides {
	/** Override the agent's default model for this slot */
	model?: string;
	/** Override the agent's default system prompt for this slot */
	systemPrompt?: WorkflowNodeAgentOverride;
	/** Override the agent's default instructions for this slot */
	instructions?: WorkflowNodeAgentOverride;
}

/**
 * Two-layer composition: applies a slot override on top of a base value.
 *
 * - If `override` is absent (undefined), returns the `base` unchanged.
 * - If `override.mode === 'override'`, returns `override.value` (replaces base).
 * - If `override.mode === 'expand'`, returns `base + '\n\n' + override.value`.
 *   When `base` is empty/null/undefined, only `override.value` is returned.
 */
export function composePromptLayer(
	base: string | null | undefined,
	override: WorkflowNodeAgentOverride | undefined
): string {
	if (!override) return base?.trim() ?? '';
	const trimmedBase = base?.trim() ?? '';
	const trimmedValue = override.value.trim();
	if (override.mode === 'override') return trimmedValue;
	// expand mode — if value is empty after trimming, just return base
	if (!trimmedValue) return trimmedBase;
	if (!trimmedBase) return trimmedValue;
	return `${trimmedBase}\n\n${trimmedValue}`;
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
 * Applies the slot's `systemPrompt` override (if any) on top of the agent's
 * base `systemPrompt` using two-layer composition.
 */
export function buildCustomAgentSystemPrompt(
	customAgent: SpaceAgent,
	slotOverrides?: SlotOverrides
): string {
	return composePromptLayer(customAgent.systemPrompt, slotOverrides?.systemPrompt);
}

/**
 * Build the initial user message for a custom agent session.
 *
 * This message contains only factual task/workflow/space context.
 * Slot-level instructions override is composed separately and passed as
 * part of the initial message when provided.
 */
export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
	const { task, workflowRun, workflow, space, previousTaskSummaries, slotOverrides } = config;

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
				if (node.instructions) {
					sections.push(`  Instructions: ${node.instructions}`);
				}
			}
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

	// Compose slot-level instructions override on top of agent's base instructions.
	// When present, this provides the node-specific HOW for the agent.
	const composedInstructions = composePromptLayer(
		customAgentInstructions(config.customAgent, config),
		slotOverrides?.instructions
	);
	if (composedInstructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(composedInstructions);
	}

	return sections.join('\n');
}

/**
 * Extract the agent's instructions field for composition.
 * Used as the base layer for slot-level instruction overrides.
 */
function customAgentInstructions(
	customAgent: SpaceAgent,
	_config: CustomAgentConfig
): string | null {
	return customAgent.instructions;
}

/**
 * Create an `AgentSessionInit` for a Space agent session.
 *
 * Workflow execution is WYSIWYG:
 * - inside a workflow run, the workflow slot prompt is the only behavioral prompt
 * - outside a workflow run, the agent's own `systemPrompt` is used
 *
 * Override/expand composition:
 * - `slotOverrides.systemPrompt` composes on top of `customAgent.systemPrompt`
 * - `slotOverrides.instructions` composes on top of `customAgent.instructions`
 */
export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
	const { customAgent, space, sessionId, workspacePath, slotOverrides } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;
	const model =
		slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	const visiblePrompt = buildCustomAgentSystemPrompt(customAgent, slotOverrides);

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
