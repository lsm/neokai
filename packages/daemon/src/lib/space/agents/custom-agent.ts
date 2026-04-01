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
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { getFeaturesForRole } from './seed-agents';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Per-slot overrides from a `WorkflowNodeAgent` entry.
 * Applied on top of the base `SpaceAgent` config when spawning a specific slot.
 */
export interface SlotOverrides {
	/** Override the agent's default model for this slot */
	model?: string;
	/** Override the agent's default system prompt for this slot */
	systemPrompt?: string;
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
 * This function intentionally returns only the visible prompt text configured by
 * the user or workflow. No role-based behavioral instructions are injected.
 */
export function buildCustomAgentSystemPrompt(customAgent: SpaceAgent): string {
	return customAgent.systemPrompt?.trim() ?? '';
}

/**
 * Build the initial user message for a custom agent session.
 *
 * This message contains only factual task/workflow/space context.
 */
export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
	const { task, workflowRun, workflow, space, previousTaskSummaries } = config;

	const sections: string[] = [];

	sections.push(`## Task #${task.taskNumber}\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) sections.push(`**Priority:** ${task.priority}`);
	if (task.taskType) sections.push(`**Type:** ${task.taskType}`);

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

		if (workflow.rules.length > 0) {
			sections.push(`\n**Workflow Rules:**`);
			for (const rule of workflow.rules) {
				sections.push(`- **${rule.name}:** ${rule.content}`);
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

	return sections.join('\n');
}

/**
 * Create an `AgentSessionInit` for a Space agent session.
 *
 * Workflow execution is WYSIWYG:
 * - inside a workflow run, the workflow slot prompt is the only behavioral prompt
 * - outside a workflow run, the agent's own `systemPrompt` is used
 */
export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
	const { customAgent, space, sessionId, workspacePath, slotOverrides, workflowRun } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;
	const model =
		slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	const promptAgent: SpaceAgent =
		workflowRun !== null
			? { ...customAgent, systemPrompt: slotOverrides?.systemPrompt }
			: slotOverrides?.systemPrompt !== undefined
				? { ...customAgent, systemPrompt: slotOverrides.systemPrompt }
				: customAgent;
	const visiblePrompt = buildCustomAgentSystemPrompt(promptAgent);

	if (customTools) {
		const agentKey = sanitizeAgentKey(customAgent.name);
		const agentDef: AgentDefinition = {
			description:
				customAgent.description ??
				`Custom ${getRoleLabel(customAgent.role)} agent: ${customAgent.name}`,
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
			features: getFeaturesForRole(customAgent.role),
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
		features: getFeaturesForRole(customAgent.role),
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
	} = config;

	if (!task.customAgentId) {
		throw new Error(
			`Task "${task.id}" has no agentId — assign a SpaceAgent to the task before calling resolveAgentInit()`
		);
	}

	const agent = agentManager.getById(task.customAgentId);
	if (!agent) {
		throw new Error(`Agent not found: ${task.customAgentId} (task: ${task.id})`);
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

function getRoleLabel(role: string): string {
	if (!role) return 'Custom';
	return role.charAt(0).toUpperCase() + role.slice(1);
}
