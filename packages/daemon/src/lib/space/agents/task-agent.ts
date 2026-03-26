/**
 * Task Agent — System prompt builder for Task Agent sessions.
 *
 * The Task Agent is a collaboration manager that coordinates autonomous agents
 * working together on a specific Space task. It spawns sub-sessions for each
 * workflow node, monitors their completion via list_group_members (which queries
 * space_tasks for live completion state), and surfaces human gates to the user.
 * Agents drive workflow progression themselves via send_message and report_done.
 *
 * ## Behavioral contract
 * - The Task Agent does NOT execute code directly — it delegates to node agents.
 * - It does NOT bypass human gates — it surfaces them via request_human_input and waits.
 * - It does NOT make architectural decisions — the workflow defines the collaboration graph.
 *
 * ## Tool contract
 * The prompt references the following MCP tools by name. They must be registered
 * in the MCP server(s) composed with this agent's session at runtime:
 *
 *   - spawn_node_agent      — Start a sub-session for a workflow step's assigned agent
 *   - check_node_status     — Poll the status/output of a running node agent session
 *   - report_result         — Mark the task complete/failed and record the result summary
 *   - request_human_input   — Surface a human gate and block until the user responds
 *   - list_group_members    — List all group members with completion state from space_tasks
 *   - send_message          — Send a message to peer node agents (string-based target)
 *
 * ## Node agent tools (for reference)
 * Node agents have their own peer communication tools:
 *   - list_peers            — Discover peers and their completion state (queries space_tasks)
 *   - send_message          — Channel-validated messaging (agent name→DM, node name→fan-out)
 *   - report_done           — Signal task completion with an optional summary
 *   - list_reachable_agents — Discover which agents/nodes are reachable and gate status
 *
 * ## Content interpolation
 * All operator-supplied content (space.backgroundContext, space.instructions,
 * task.description, agent names/descriptions, step instructions, workflow rules,
 * and previousTaskSummaries) is interpolated directly into the prompt without
 * sanitization. These are operator-controlled fields on a self-hosted tool, so
 * no sanitization is needed — consistent with the approach in space-chat-agent.ts.
 *
 * ## Task context duplication
 * Task details (title, priority, status, description, dependencies) appear in
 * BOTH the system prompt (for persistent LLM context) and the initial message
 * (for actionable task assignment). This intentional redundancy is a common LLM
 * prompt pattern that improves context reliability. Do not remove one without
 * removing the other.
 */

import type {
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	Space,
	SpaceAgent,
	WorkflowNode,
	WorkflowChannel,
	WorkflowCondition,
	WorkflowTransition,
	WorkflowRule,
	SessionFeatures,
} from '@neokai/shared';
import { resolveNodeAgents } from '@neokai/shared';
import type { AgentSessionInit } from '../../agent/agent-session';
import { inferProviderForModel } from '../../providers/registry';

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Summary of a previous task's result — used for context continuity. */
export interface PreviousTaskSummary {
	taskId: string;
	title: string;
	status: string;
	result?: string | null;
}

/** Full context passed to the Task Agent prompt builder. */
export interface TaskAgentContext {
	/** The task this agent is orchestrating. */
	task: SpaceTask;
	/** The workflow definition to execute (optional — task may have no workflow). */
	workflow?: SpaceWorkflow;
	/** The active workflow run for this task (optional). */
	workflowRun?: SpaceWorkflowRun;
	/** The Space this task belongs to. */
	space: Space;
	/** Available agents in this Space. */
	availableAgents: SpaceAgent[];
	/** Results of previously completed tasks — for context continuity. */
	previousTaskSummaries?: PreviousTaskSummary[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatStep(step: WorkflowNode, agents: SpaceAgent[]): string {
	const nodeAgents = resolveNodeAgents(step);
	let agentLabel: string;
	if (nodeAgents.length === 1) {
		const a = agents.find((ag) => ag.id === nodeAgents[0].agentId);
		agentLabel = a ? `${a.name} (role: ${a.role})` : `agent id: ${nodeAgents[0].agentId}`;
	} else {
		const labels = nodeAgents.map((sa) => {
			const a = agents.find((ag) => ag.id === sa.agentId);
			return a ? `${a.name} (role: ${a.role})` : `agent id: ${sa.agentId}`;
		});
		agentLabel = labels.join(', ');
	}
	const instructions = step.instructions ? `\n    Instructions: ${step.instructions}` : '';
	return `- **${step.name}** (id: \`${step.id}\`, assigned to: ${agentLabel})${instructions}`;
}

function formatTransition(t: WorkflowTransition): string {
	let conditionLabel = '';
	if (t.condition) {
		if (t.condition.type === 'human') {
			conditionLabel = ' [HUMAN GATE]';
		} else if (t.condition.type === 'condition') {
			conditionLabel = ` [condition: ${t.condition.expression ?? '?'}]`;
		} else if (t.condition.type === 'task_result') {
			conditionLabel = ` [result matches "${t.condition.expression ?? '?'}"]`;
		}
		// 'always' transitions produce no label — they are unconditional, semantically
		// identical to a transition with no condition object. Any future WorkflowConditionType
		// values not handled here will also produce no label; add a branch above when new
		// types are introduced.
	}
	return `- \`${t.from}\` → \`${t.to}\`${conditionLabel}`;
}

function formatRule(rule: WorkflowRule): string {
	const scope =
		rule.appliesTo && rule.appliesTo.length > 0
			? ` (steps: ${rule.appliesTo.join(', ')})`
			: ' (all steps)';
	return `- **${rule.name}**${scope}: ${rule.content}`;
}

function formatGateCondition(gate: WorkflowCondition): string {
	if (gate.type === 'always') return '';
	if (gate.type === 'human') return ' **[HUMAN GATE — call request_human_input]**';
	if (gate.type === 'condition') return ` [condition gate: ${gate.expression ?? '?'}]`;
	if (gate.type === 'task_result')
		return ` [task_result gate: matches "${gate.expression ?? '?'}"]`;
	return '';
}

function formatChannel(ch: WorkflowChannel): string {
	const to = Array.isArray(ch.to) ? ch.to.join(', ') : ch.to;
	const dir = ch.direction === 'bidirectional' ? '↔' : '→';
	const gateLabel = ch.gate ? formatGateCondition(ch.gate) : '';
	const label = ch.label ? ` (${ch.label})` : '';
	return `- \`${ch.from}\` ${dir} \`${to}\`${label}${gateLabel}`;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for a Task Agent session.
 *
 * The prompt clearly defines:
 *   1. The Task Agent's role as a workflow orchestrator
 *   2. Available MCP tools and when to use each
 *   3. Workflow execution instructions
 *   4. Human gate handling rules
 *   5. Behavioral constraints (no direct code execution, no bypassing gates)
 *   6. Task context (title, description, priority, dependencies)
 */
export function buildTaskAgentSystemPrompt(context: TaskAgentContext): string {
	const sections: string[] = [];

	// ---- Role ----------------------------------------------------------------
	sections.push(
		`You are a Task Agent — a collaboration manager that coordinates autonomous agents ` +
			`working together on a task within NeoKai, an autonomous AI software development tool.\n` +
			`\n` +
			`Your job is to enable the collaboration to succeed by:\n` +
			`1. Spawning node agents for each workflow node and providing them with the collaboration context\n` +
			`2. Monitoring agent completion via \`list_group_members\` (queries space_tasks for live completion state)\n` +
			`3. Surfacing human gates encountered during agent communication and waiting for approval via \`request_human_input\`\n` +
			`4. Reporting the final result when all agents have completed their work`
	);

	// ---- Space context -------------------------------------------------------
	if (context.space.backgroundContext) {
		sections.push(`\n## Space Background\n\n${context.space.backgroundContext}`);
	}

	if (context.space.instructions) {
		sections.push(`\n## Space Instructions\n\n${context.space.instructions}`);
	}

	// ---- MCP Tools -----------------------------------------------------------
	sections.push(`\n## Available MCP Tools\n`);
	sections.push(
		`These tools are available to you. Use them in the order described in the execution ` +
			`instructions below. Do not invent or call tools that are not listed here.`
	);
	sections.push('');
	sections.push(
		`- **spawn_node_agent** — Start a sub-session for the current workflow step. ` +
			`Pass the \`step_id\` and optional override instructions. ` +
			`Returns a \`session_id\` for the spawned sub-session. ` +
			`Call this when a new step task needs to be executed.`
	);
	sections.push(
		`- **check_node_status** — Poll the status and output of a running node agent session. ` +
			`Pass the \`session_id\` returned by \`spawn_node_agent\`. ` +
			`Returns the session's current status (\`running\`, \`completed\`, \`error\`) and output. ` +
			`Call this to determine when a step has finished.`
	);
	sections.push(
		`- **report_result** — Mark the task as completed or failed and record a result summary. ` +
			`Pass \`status\` (\`completed\`, \`needs_attention\`, or \`cancelled\`) and a \`summary\` string. ` +
			`Call this when the workflow reaches a terminal step or an unrecoverable error occurs.`
	);
	sections.push(
		`- **request_human_input** — Surface a human gate and block until the human responds. ` +
			`Pass a \`question\` describing what decision or approval is needed. ` +
			`Returns the human's response. ` +
			`Call this when a node agent pauses for human input.`
	);
	sections.push(
		`- **list_group_members** — List all members of the current task's session group. ` +
			`Returns each member's \`sessionId\`, \`agentName\`, \`status\`, \`completionState\`, and ` +
			`\`permittedTargets\`. Completion state is read from \`space_tasks\` — use this to monitor ` +
			`when all agents have called \`report_done\`. Poll this after each check_node_status to detect ` +
			`overall collaboration completion.`
	);
	sections.push(
		`- **send_message** — Send a message to a peer node agent using a plain string target. ` +
			`Target resolution: agent name (e.g. \`"coder"\`) → DM to that agent; ` +
			`node name (e.g. \`"review-node"\`) → fan-out to all agents in that node; ` +
			`\`"*"\` → broadcast to all permitted targets. ` +
			`The Task Agent has default bidirectional channels to all node agents. ` +
			`Use \`list_group_members\` to see permitted targets before sending.`
	);
	sections.push(
		`**Node agent tools (for reference):** Each spawned node agent also has access to: ` +
			`\`list_peers\` (discover peers with completion state from space_tasks), ` +
			`\`send_message\` (same string-based targeting), ` +
			`\`report_done\` (signal task completion), and ` +
			`\`list_reachable_agents\` (discover reachable agents and cross-node gate status). ` +
			`Node agents drive their own progression — you do not need to manually route messages between them.`
	);

	// ---- Workflow execution instructions ------------------------------------
	sections.push(`\n## Collaboration Execution Instructions\n`);
	sections.push(
		`In the agent-centric model, node agents are self-directing participants that communicate ` +
			`via declared channels and signal completion via \`report_done\`. Your role is to spawn agents, ` +
			`monitor the collaboration, and handle gate events — you do not manually route messages between agents.\n`
	);
	sections.push(`Follow this loop until all agents have completed:\n`);
	sections.push(
		`1. **Spawn pending node agents** — Call \`spawn_node_agent\` for each pending step task ` +
			`(visible in the task list). Multiple agents may run concurrently in the same node.\n` +
			`2. **Monitor completion** — Call \`check_node_status\` periodically, then call ` +
			`\`list_group_members\` to check each member's \`completionState\` (read from space_tasks). ` +
			`A member is done when its \`completionState.status\` is \`completed\` or \`error\`.\n` +
			`3. **Agents drive their own progression** — When a node agent sends a message to another ` +
			`agent via \`send_message\` (using an agent name for DM or a node name for fan-out), ` +
			`the target node is activated automatically. New pending tasks will appear — spawn their agents (return to step 1).\n` +
			`4. **Handle gate-blocked messages** — Channels may have gate conditions that block delivery: ` +
			`a \`human\` gate requires explicit approval (call \`request_human_input\`); ` +
			`\`condition\` and \`task_result\` gates are evaluated automatically by the system. ` +
			`If a node agent reports that a message was blocked by a gate, surface the gate to the user.\n` +
			`5. **Detect completion** — When \`list_group_members\` shows all members have completed, ` +
			`call \`report_result\` to close the task.\n` +
			`6. **Handle errors** — If a node agent errors, call \`report_result\` with ` +
			`\`status: "cancelled"\` and the error details.`
	);

	// ---- Human gate handling -------------------------------------------------
	sections.push(`\n## Human Gate Handling\n`);
	sections.push(
		`When a node agent requires human input or approval:\n` +
			`1. Call \`request_human_input\` with a clear description of the decision needed.\n` +
			`2. Wait — do not proceed until the tool returns the human's response.\n` +
			`3. Use the human's response to guide next steps.\n` +
			`\n` +
			`**Never bypass a human gate.** Surfacing decisions to the human is a core part of ` +
			`the supervised autonomy model. Even if you believe you know the right answer, ` +
			`you must wait for explicit human approval before continuing.`
	);

	// ---- Behavioral rules ---------------------------------------------------
	sections.push(`\n## Behavioral Rules\n`);
	sections.push(
		`These rules govern your behavior as a Task Agent. Violating them is a critical error.\n`
	);
	sections.push(
		`1. **Do not execute code directly.** You are an orchestrator, not an executor. ` +
			`All code execution, file editing, and git operations must be delegated to ` +
			`node agents via \`spawn_node_agent\`. You have no direct access to the filesystem.\n`
	);
	sections.push(
		`2. **Do not bypass human gates.** When a workflow transition requires human approval, ` +
			`you must call \`request_human_input\` and wait. Never assume approval or skip the gate.\n`
	);
	sections.push(
		`3. **Do not make architectural decisions.** The workflow defines the process. ` +
			`If you disagree with a step or transition, surface the concern to the human via ` +
			`\`request_human_input\` — do not silently deviate from the workflow.\n`
	);
	sections.push(
		`4. **Report results accurately.** When calling \`report_result\`, include a factual ` +
			`summary of what was accomplished. Do not embellish or speculate.\n`
	);
	sections.push(
		`5. **Spawn pending agents promptly.** When new pending step tasks appear (activated by ` +
			`agent-to-agent messaging), spawn their agents without unnecessary delay. ` +
			`Multiple agents may run concurrently when the workflow activates parallel nodes.`
	);

	// ---- Channel topology ----------------------------------------------------
	sections.push(`\n## Channel-Based Messaging\n`);
	sections.push(
		`The workflow declares a channel topology — a graph of permitted communication paths between agents. ` +
			`Channels enforce collaboration policies: only agents with a declared channel between them can exchange messages.\n`
	);
	sections.push(
		`**String-based target addressing** — \`send_message\` uses a plain string \`target\`:\n` +
			`- Agent name (e.g. \`"coder"\`) → direct message to that specific agent\n` +
			`- Node name (e.g. \`"review-node"\`) → fan-out to all agents in that node\n` +
			`- \`"*"\` → broadcast to all permitted targets\n` +
			`Use \`list_group_members\` to see permitted targets, or node agents can use ` +
			`\`list_reachable_agents\` to discover their full reachability graph including cross-node targets and gate status.\n`
	);
	sections.push(
		`**Gate conditions** — Channels may declare a gate that blocks message delivery until a condition is met:\n` +
			`- \`human\` gate: requires explicit human approval — call \`request_human_input\` with the gate context\n` +
			`- \`condition\` gate: system evaluates the expression automatically\n` +
			`- \`task_result\` gate: system checks whether the prior task result matches the expression\n` +
			`- No gate (or \`always\`): message is delivered immediately\n`
	);
	sections.push(
		`The Task Agent has default bidirectional channels to all node agent roles. ` +
			`Node agents use \`list_reachable_agents\` to discover their full reachability graph.`
	);

	// ---- Task context -------------------------------------------------------
	sections.push(`\n## Task Details\n`);
	sections.push(`**Title:** ${context.task.title}`);
	sections.push(`**Priority:** ${context.task.priority}`);
	sections.push(`**Status:** ${context.task.status}`);
	if (context.task.description) {
		sections.push(`\n**Description:**\n${context.task.description}`);
	}
	if (context.task.dependsOn && context.task.dependsOn.length > 0) {
		sections.push(`\n**Dependencies:** ${context.task.dependsOn.join(', ')}`);
	}

	return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Initial message builder
// ---------------------------------------------------------------------------

/**
 * Build the first user message sent to the Task Agent.
 *
 * This message provides the agent with:
 *   1. The task assignment details
 *   2. The full workflow structure (steps, transitions, conditions, rules)
 *   3. Available agents and their roles
 *   4. Previous task results for context continuity
 */
export function buildTaskAgentInitialMessage(context: TaskAgentContext): string {
	const parts: string[] = [];

	// ---- Task assignment -----------------------------------------------------
	parts.push(
		`## Task Assignment\n` +
			`\n` +
			`You have been assigned the following task:\n` +
			`\n` +
			`**Title:** ${context.task.title}\n` +
			`**Priority:** ${context.task.priority}\n` +
			`**Status:** ${context.task.status}`
	);

	if (context.task.description) {
		parts.push(`\n**Description:**\n${context.task.description}`);
	}

	if (context.task.dependsOn && context.task.dependsOn.length > 0) {
		parts.push(`\n**Depends on:** ${context.task.dependsOn.join(', ')}`);
	}

	// ---- Workflow structure --------------------------------------------------
	if (context.workflow) {
		const wf = context.workflow;

		parts.push(`\n## Workflow: ${wf.name}`);

		if (wf.description) {
			parts.push(`\n${wf.description}`);
		}

		if (wf.nodes.length > 0) {
			parts.push(`\n### Steps (execution order defined by transitions)\n`);
			parts.push(`**Start step:** \`${wf.startNodeId}\`\n`);
			for (const step of wf.nodes) {
				parts.push(formatStep(step, context.availableAgents));
			}
		} else {
			parts.push(`\n_This workflow has no steps defined._`);
		}

		if (wf.transitions.length > 0) {
			parts.push(`\n### Transitions\n`);
			for (const t of wf.transitions) {
				parts.push(formatTransition(t));
			}
		}

		if (wf.rules && wf.rules.length > 0) {
			parts.push(`\n### Workflow Rules\n`);
			for (const rule of wf.rules) {
				parts.push(formatRule(rule));
			}
		}

		if (context.workflowRun) {
			const run = context.workflowRun;
			parts.push(`\n### Active Workflow Run\n`);
			parts.push(`**Run ID:** \`${run.id}\``);
			parts.push(`**Run Title:** ${run.title}`);
			if (run.description) {
				parts.push(`**Run Description:** ${run.description}`);
			}
			if (run.currentNodeId) {
				const currentStep = wf.nodes.find((s) => s.id === run.currentNodeId);
				const stepName = currentStep ? currentStep.name : run.currentNodeId;
				parts.push(`**Current Step:** ${stepName} (\`${run.currentNodeId}\`)`);
			}
		}
	} else {
		parts.push(
			`\n## Workflow\n\n` +
				`No workflow is assigned to this task. Execute the task directly using the ` +
				`most appropriate agent from the available agents list below.`
		);
	}

	// ---- Collaboration context: channel map ---------------------------------
	if (context.workflow) {
		const channels = context.workflow.channels;
		if (channels && channels.length > 0) {
			parts.push(`\n## Collaboration Channel Map\n`);
			parts.push(
				`The following channels define how agents may communicate in this workflow. ` +
					`Channels with gates enforce delivery policies — messages are held until the gate condition passes.\n` +
					`\n` +
					`**Target addressing:** use an agent name for a direct message (DM) or a node name for ` +
					`fan-out to all agents in that node. Node agents can call \`list_reachable_agents\` to ` +
					`discover their full reachability graph.\n`
			);
			for (const ch of channels) {
				parts.push(formatChannel(ch));
			}
		} else {
			parts.push(`\n## Collaboration Channel Map\n`);
			parts.push(
				`No channels are declared for this workflow. ` +
					`Agents are fully isolated — \`send_message\` is unavailable unless channels are added.`
			);
		}
	}

	// ---- Available agents ---------------------------------------------------
	if (context.availableAgents.length > 0) {
		parts.push(`\n## Available Agents\n`);
		for (const agent of context.availableAgents) {
			const desc = agent.description ? ` — ${agent.description}` : '';
			const model = agent.model ? ` (model: ${agent.model})` : '';
			parts.push(`- **${agent.name}** (id: \`${agent.id}\`, role: ${agent.role})${model}${desc}`);
		}
	} else {
		parts.push(`\n## Available Agents\n\n_No agents are configured in this Space._`);
	}

	// ---- Previous task results ----------------------------------------------
	if (context.previousTaskSummaries && context.previousTaskSummaries.length > 0) {
		parts.push(`\n## Previous Task Results (Context)\n`);
		parts.push(
			`The following tasks have already been completed. Use their results as context ` +
				`when executing the current task.\n`
		);
		for (const prev of context.previousTaskSummaries) {
			parts.push(`### ${prev.title} (id: \`${prev.taskId}\`)`);
			parts.push(`**Status:** ${prev.status}`);
			if (prev.result) {
				parts.push(`**Result:** ${prev.result}`);
			}
		}
	}

	// ---- Start instruction --------------------------------------------------
	parts.push(`\n---\n`);
	if (context.workflow && context.workflow.nodes.length > 0) {
		// Normal case: workflow with steps — spawn the start step's agent.
		parts.push(
			`Begin executing the workflow now. Start by calling \`spawn_node_agent\` ` +
				`for the start step (\`${context.workflow.startNodeId}\`).`
		);
	} else if (context.workflow && context.workflow.nodes.length === 0) {
		// Degenerate case: workflow exists but defines no steps.
		// spawn_node_agent requires a step_id, so there is nothing to execute.
		// Surface this as an immediate failure rather than leaving the agent in
		// an impossible state trying to spawn a step with no ID.
		parts.push(
			`**Warning:** The assigned workflow "${context.workflow.name}" has no steps defined. ` +
				`There is nothing to execute. Call \`report_result\` immediately with ` +
				`\`status: "cancelled"\` and a summary explaining that the workflow has no steps.`
		);
	} else {
		// No workflow assigned — spawn the most appropriate agent directly.
		parts.push(
			`Begin executing the task now. Spawn the most appropriate agent using ` +
				`\`spawn_node_agent\` and monitor its completion.`
		);
	}

	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Session init factory
// ---------------------------------------------------------------------------

const DEFAULT_TASK_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

const TASK_AGENT_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: true,
};

/**
 * Configuration for creating a Task Agent session.
 *
 * NOTE: MCP servers are intentionally NOT included here — they are attached at
 * runtime by the TaskAgentManager after the session is created. This allows the
 * manager to compose the MCP server with live runtime dependencies (session manager,
 * task manager, workflow executor) that are unavailable at init time.
 */
export interface TaskAgentSessionConfig {
	/** The task this agent will orchestrate */
	task: SpaceTask;
	/** The Space this task belongs to */
	space: Space;
	/** The workflow definition to execute (optional) */
	workflow?: SpaceWorkflow | null;
	/** The active workflow run for this task (optional) */
	workflowRun?: SpaceWorkflowRun | null;
	/** Session ID for the new session */
	sessionId: string;
	/** Workspace path (typically space.workspacePath) */
	workspacePath: string;
}

/**
 * Create an AgentSessionInit for a Task Agent session.
 *
 * The Task Agent is a built-in orchestrator session type (`space_task_agent`) that
 * manages a single SpaceTask's workflow. It uses the task agent system prompt and
 * does NOT include MCP servers — those are attached at runtime by the TaskAgentManager.
 *
 * Model resolution: Space.defaultModel → hardcoded default.
 */
export function createTaskAgentInit(config: TaskAgentSessionConfig): AgentSessionInit {
	const { task, space, workflow, workflowRun, sessionId, workspacePath } = config;

	const model = space.defaultModel ?? DEFAULT_TASK_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	const systemPromptText = buildTaskAgentSystemPrompt({
		task,
		space,
		workflow: workflow ?? undefined,
		workflowRun: workflowRun ?? undefined,
		// availableAgents is required by TaskAgentContext but buildTaskAgentSystemPrompt()
		// does not render an "Available Agents" section — that section only appears in
		// buildTaskAgentInitialMessage(). The factory does not have agent data at init time,
		// and passing an empty array here has no effect on the system prompt content.
		// The caller must provide agent context via buildTaskAgentInitialMessage() instead.
		availableAgents: [],
	});

	return {
		sessionId,
		workspacePath,
		systemPrompt: systemPromptText,
		features: TASK_AGENT_FEATURES,
		context: { spaceId: space.id, taskId: task.id },
		type: 'space_task_agent',
		model,
		provider,
		contextAutoQueue: false,
	};
}
