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
	WorkflowChannel,
	WorkflowNode,
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { Logger } from '../../logger';
import { SUB_SESSION_FEATURES } from './seed-agents';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * Soft size budget for the initial user message. When exceeded, a warning is
 * logged so future prompt bloat is caught during development. Never fails.
 */
const USER_MESSAGE_SOFT_LIMIT_BYTES = 4 * 1024;

const log = new Logger('custom-agent');

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

/**
 * A snapshot of gate runtime data passed into `buildCustomAgentTaskMessage`.
 * The builder uses these records to derive runtime state such as the current
 * PR URL (any gate record with a `pr_url` string field is considered).
 */
export interface GateDataSnapshot {
	gateId: string;
	data: Record<string, unknown>;
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
	/**
	 * ID of the workflow node this session belongs to (required to scope the
	 * "Your Role in This Workflow" section to the current node's peers,
	 * channels, and gates). Omit when running outside a workflow.
	 */
	nodeId?: string;
	/**
	 * Agent slot name for the current node execution (`WorkflowNodeAgent.name`).
	 * Used together with the node name to compute the set of gates the agent
	 * can write to.
	 */
	agentSlotName?: string;
	/**
	 * Snapshot of gate data for the current workflow run. Used to derive
	 * runtime state such as the current PR URL ("Runtime Location" section).
	 * Absent when running outside a workflow or when no data has been written.
	 */
	gateData?: GateDataSnapshot[];
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
 *
 * Section order (top → bottom), action-first:
 *   1. `## Your Task` — title, description, priority
 *   2. `## Runtime Location` — worktree path, derived PR URL
 *   3. `## Your Role in This Workflow` — current node, peers, outbound channels,
 *      writable gates (omitted outside a workflow)
 *   4. `## Previous Work on This Goal` — bulleted summaries
 *   5. `## Project Context` — space.backgroundContext
 *   6. `## Standing Instructions` — space.instructions + workflow.instructions
 *
 * Node UUIDs are intentionally dropped — they are not useful to the LLM and add
 * noise. The previous "Workflow Context" + "Workflow Structure" sections are
 * replaced by the scoped "Your Role" section.
 */
export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
	const {
		task,
		workflowRun,
		workflow,
		space,
		workspacePath,
		previousTaskSummaries,
		nodeId,
		agentSlotName,
		gateData,
	} = config;

	const sections: string[] = [];

	// 1. Task — actionable content first, so it lands in the first 500 chars.
	sections.push(`## Your Task #${task.taskNumber}`);
	sections.push('');
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) sections.push(`**Priority:** ${task.priority}`);

	// 2. Runtime Location — worktree is always known, PR URL derived from gate data.
	const prUrl = derivePrUrlFromGateData(gateData);
	sections.push('');
	sections.push('## Runtime Location');
	sections.push('');
	sections.push(`- Worktree: ${workspacePath}`);
	sections.push(`- PR: ${prUrl ?? 'none yet'}`);

	// 3. Your Role in This Workflow — scoped to the current node when known.
	const roleLines = buildRoleSection(workflow, nodeId, agentSlotName);
	if (roleLines.length > 0) {
		sections.push('');
		sections.push('## Your Role in This Workflow');
		sections.push('');
		sections.push(...roleLines);
	}

	// 4. Previous work summaries.
	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push('');
		sections.push('## Previous Work on This Goal');
		sections.push('');
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	// 5. Project context from the Space.
	if (space.backgroundContext) {
		sections.push('');
		sections.push('## Project Context');
		sections.push('');
		sections.push(space.backgroundContext);
	}

	// 6. Standing instructions — space + workflow combined under one heading.
	const standingLines: string[] = [];
	if (space.instructions?.trim()) standingLines.push(space.instructions.trim());
	if (workflow?.instructions?.trim()) standingLines.push(workflow.instructions.trim());
	if (standingLines.length > 0) {
		sections.push('');
		sections.push('## Standing Instructions');
		sections.push('');
		sections.push(standingLines.join('\n\n'));
	}

	const message = sections.join('\n');

	// Soft budget: warn but never fail when the message exceeds the threshold.
	// `workflowRun` is used to scope the warning to workflow sessions (avoids
	// noise during short standalone tasks where large backgroundContext is
	// typically the cause and not a regression).
	const byteLength = Buffer.byteLength(message, 'utf8');
	if (workflowRun && byteLength > USER_MESSAGE_SOFT_LIMIT_BYTES) {
		log.warn(
			`buildCustomAgentTaskMessage: user message is ${byteLength} bytes ` +
				`(soft limit ${USER_MESSAGE_SOFT_LIMIT_BYTES}). ` +
				`taskId=${task.id} workflowRunId=${workflowRun.id}${nodeId ? ` nodeId=${nodeId}` : ''}. ` +
				`Consider trimming space.backgroundContext or workflow.instructions.`
		);
	}

	return message;
}

/**
 * Resolve a PR URL from a snapshot of gate data. The first gate record whose
 * data contains a non-empty `pr_url` string wins. Returns `undefined` when no
 * such field is present.
 */
function derivePrUrlFromGateData(gateData: GateDataSnapshot[] | undefined): string | undefined {
	if (!gateData || gateData.length === 0) return undefined;
	for (const record of gateData) {
		const value = record.data?.pr_url;
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Build the bulleted "Your Role in This Workflow" lines scoped to the current
 * node. Returns `[]` when the workflow or current node cannot be resolved so
 * the caller can cleanly omit the section.
 */
function buildRoleSection(
	workflow: SpaceWorkflow | null | undefined,
	nodeId: string | undefined,
	agentSlotName: string | undefined
): string[] {
	if (!workflow) return [];
	if (!workflow.nodes || workflow.nodes.length === 0) return [];

	const currentNode: WorkflowNode | undefined = nodeId
		? workflow.nodes.find((n) => n.id === nodeId)
		: undefined;
	if (!currentNode) return [];

	const lines: string[] = [`- Node: ${currentNode.name}`];

	const peers = workflow.nodes.filter((n) => n.id !== currentNode.id).map((n) => n.name);
	if (peers.length > 0) {
		lines.push(`- Peers: ${peers.join(', ')}`);
	}

	const outboundChannels = (workflow.channels ?? []).filter((ch) =>
		isChannelFromNode(ch, currentNode.name)
	);
	if (outboundChannels.length > 0) {
		lines.push(`- Channels from this node: ${outboundChannels.map(describeChannel).join('; ')}`);
	}

	const writableGates = (workflow.gates ?? []).filter((gate) =>
		isGateWritableFromNode(gate.fields, currentNode.name, agentSlotName)
	);
	if (writableGates.length > 0) {
		lines.push(
			`- Gates you can write: ${writableGates
				.map((g) => (g.label ? `${g.id} (${g.label})` : g.id))
				.join(', ')}`
		);
	}

	return lines;
}

function isChannelFromNode(channel: WorkflowChannel, nodeName: string): boolean {
	if (channel.from === '*') return true;
	return channel.from === nodeName;
}

function describeChannel(channel: WorkflowChannel): string {
	const target = Array.isArray(channel.to) ? channel.to.join(', ') : channel.to;
	return channel.label ? `${target} (${channel.label})` : target;
}

function isGateWritableFromNode(
	fields: Array<{ writers: string[] }> | undefined,
	nodeName: string,
	agentSlotName: string | undefined
): boolean {
	if (!fields || fields.length === 0) return false;
	const candidates = [nodeName.toLowerCase()];
	if (agentSlotName) candidates.push(agentSlotName.toLowerCase());
	return fields.some((field) => {
		return field.writers.some((writer) => {
			const w = writer.toLowerCase();
			return w === '*' || candidates.includes(w);
		});
	});
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
	const { customAgent, task, space, sessionId, workspacePath, slotOverrides } = config;

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
			// Include taskId on the context so long-lived node-agent sub-sessions
			// (type: 'worker') are recognised as orchestration-state carriers and
			// their sdkSessionId is preserved across runtime-fingerprint changes.
			// See `AgentSession.fromInit` for the preservation guard.
			context: { spaceId: space.id, taskId: task.id },
			type: 'worker',
			model,
			provider,
			agent: agentKey,
			agents: { [agentKey]: agentDef },
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
