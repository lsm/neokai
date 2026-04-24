/**
 * Task Agent — System prompt builder for Task Agent sessions.
 *
 * The Task Agent is a collaboration manager that coordinates human and workflow
 * communication for a specific Space task. Workflow node sessions are spawned and
 * progressed by SpaceRuntime. The Task Agent monitors execution state via
 * list_group_members, relays intent via send_message, and surfaces human gates.
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
 *   - save_artifact         — Append an audit record for this task (type, summary, optional data)
 *   - list_artifacts        — List artifacts for the current workflow run
 *   - approve_task          — Self-close the task as done (gated by autonomy level)
 *   - submit_for_approval   — Request human sign-off instead of self-closing
 *   - request_human_input   — Surface a human gate and block until the user responds
 *   - list_group_members    — List all group members with completion state from space_tasks
 *   - send_message          — Send a message to peer node agents (string-based target)
 *
 * ## Node agent tools (for reference)
 * Node agents have their own peer communication tools:
 *   - list_peers            — Discover peers and their completion state (queries space_tasks)
 *   - send_message          — Channel-validated messaging; auto-writes gate data when channel has a gate
 *   - save_artifact         — Persist typed artifacts to the workflow run store; does not change node status
 *   - list_reachable_agents — Discover which agents/nodes are reachable and gate status
 *
 * ## Content interpolation
 * All operator-supplied content (space.backgroundContext, space.instructions,
 * task.description, agent names/descriptions, node instructions, workflow rules,
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
	SessionFeatures,
	Gate,
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

function formatNode(node: WorkflowNode, agents: SpaceAgent[]): string {
	const nodeAgents = resolveNodeAgents(node);
	let agentLabel: string;
	if (nodeAgents.length === 1) {
		const a = agents.find((ag) => ag.id === nodeAgents[0].agentId);
		agentLabel = a ? a.name : `agent id: ${nodeAgents[0].agentId}`;
	} else {
		const labels = nodeAgents.map((sa) => {
			const a = agents.find((ag) => ag.id === sa.agentId);
			return a ? a.name : `agent id: ${sa.agentId}`;
		});
		agentLabel = labels.join(', ');
	}
	return `- **${node.name}** (id: \`${node.id}\`, assigned to: ${agentLabel})`;
}

function formatChannelGateLabel(ch: WorkflowChannel, gates: Gate[]): string {
	if (!ch.gateId) return '';
	const gate = gates.find((g) => g.id === ch.gateId);
	if (!gate) return ` [gate: ${ch.gateId}]`;
	return ` [gate: ${gate.id}${gate.description ? ` — ${gate.description}` : ''}]`;
}

function formatChannel(ch: WorkflowChannel, gates: Gate[]): string {
	const to = Array.isArray(ch.to) ? ch.to.join(', ') : ch.to;
	const gateLabel = formatChannelGateLabel(ch, gates);
	const label = ch.label ? ` (${ch.label})` : '';
	return `- \`${ch.from}\` → \`${to}\`${label}${gateLabel}`;
}

function formatGate(gate: Gate): string {
	const desc = gate.description ? ` — ${gate.description}` : '';
	const fieldSummaries = (gate.fields ?? []).map((f) => {
		const writers = f.writers.length > 0 ? f.writers.join(', ') : '(none)';
		const checkDesc =
			f.check.op === 'count'
				? `count(${JSON.stringify(f.check.match)}) >= ${f.check.min}`
				: f.check.op === 'exists'
					? 'exists'
					: `${f.check.op} ${JSON.stringify(f.check.value)}`;
		return `    - \`${f.name}\` (${f.type}): ${checkDesc} — writers: ${writers}`;
	});
	return (
		`- **Gate \`${gate.id}\`**${desc}\n` +
		`  - Fields:\n${fieldSummaries.join('\n')}\n` +
		`  - Reset on cycle: ${gate.resetOnCycle}`
	);
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
			`1. Monitoring workflow activity via \`list_group_members\` (queries node execution state)\n` +
			`2. Relaying intent/messages between human and workflow agents when needed\n` +
			`3. Surfacing human gates encountered during agent communication via \`request_human_input\`\n` +
			`4. Recording outcomes via \`save_artifact\` and closing via \`approve_task\` or \`submit_for_approval\` when needed`
	);
	sections.push(
		`\n## Critical Constraints\n` +
			`- Workflow execution is runtime-driven from node executions. Do not attempt to start or activate workflow nodes.\n` +
			`- \`spawn_node_agent\` and \`check_node_status\` do not exist in this session.\n` +
			`- Operate as a communication/status helper only: summarize progress, route human intent, and surface approvals.`
	);

	// ---- MCP Tools -----------------------------------------------------------
	sections.push(`\n## Available MCP Tools\n`);
	sections.push(
		`These tools are available to you. Use them in the order described in the execution ` +
			`instructions below. Do not invent or call tools that are not listed here.`
	);
	sections.push('');
	sections.push(
		`- **save_artifact** — Append an audit record for this task. ` +
			`Pass \`type: "result"\`, \`append: true\`, and a \`summary\` string. ` +
			`Optional: include structured \`data\` fields (\`prUrl\`, \`commitSha\`, \`testOutput\`, …). ` +
			`Does NOT close the task — call \`approve_task\` or \`submit_for_approval\` to close.`
	);
	sections.push(
		`- **approve_task** — Close this task as done. ` +
			`Gated by \`space.autonomyLevel >= workflow.completionAutonomyLevel\`. ` +
			`Call only when workflow execution is complete and you can self-close. ` +
			`The runtime will return an error if the autonomy level is too low.`
	);
	sections.push(
		`- **submit_for_approval** — Request human sign-off instead of self-closing. ` +
			`Always available regardless of autonomy level. ` +
			`Use when the task is risky, ambiguous, or autonomy rules block self-close.`
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
			`\`permittedTargets\`. Completion state is read from node execution records — use this to monitor ` +
			`when all agents have reached idle status. Use it after event messages and before finalizing.`
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
			`\`list_peers\` (discover peers with completion state from node executions), ` +
			`\`send_message\` (same string-based targeting; automatically writes gate data when the channel has a gate and \`data\` is provided), ` +
			`\`save_artifact\` (persist typed artifacts to the workflow run store without changing node status), and ` +
			`\`list_reachable_agents\` (discover reachable agents and cross-node gate status). ` +
			`Node agents drive their own progression — you do not need to manually route messages between them.`
	);

	// ---- Workflow execution instructions ------------------------------------
	sections.push(`\n## Collaboration Execution Instructions\n`);
	sections.push(
		`In the agent-centric model, node agents are self-directing participants that communicate ` +
			`via declared channels and complete their work naturally when done. Your role is to monitor state, ` +
			`monitor the collaboration, and handle gate events — you do not manually route messages between agents.\n`
	);
	sections.push(`Follow this event-driven loop until all agents have completed:\n`);
	sections.push(
		`1. **Wait for events** — Stop polling and wait for inbound messages ` +
			`(for example \`[NODE_COMPLETE]\` or \`[NODE_FAILED]\`) from node-agent activity.\n` +
			`2. **React to events** — When an inbound event arrives, call \`list_group_members\` to refresh state.\n` +
			`3. **Agents drive their own progression** — When a node agent sends a message to another ` +
			`agent via \`send_message\` (using an agent name for DM or a node name for fan-out), ` +
			`the target node is activated automatically by runtime.\n` +
			`4. **Handle gate-blocked messages** — Channels may have gate conditions that block delivery: ` +
			`a \`human\` gate requires explicit approval (call \`request_human_input\`); ` +
			`\`condition\` and \`task_result\` gates are evaluated automatically by the system. ` +
			`If a node agent reports that a message was blocked by a gate, surface the gate to the user.\n` +
			`5. **Automatic workflow completion** — When the end node agent's session completes, the ` +
			`system automatically marks the workflow run and main task as completed. You do not need to ` +
			`call any completion tool — just wait for the \`[NODE_COMPLETE]\` event from the end node. ` +
			`Use \`list_group_members\` to verify all agents have reached idle status if needed. ` +
			`Only call \`save_artifact\` + \`approve_task\`/\`submit_for_approval\` if you need to cancel or signal an unrecoverable error.\n` +
			`6. **Handle errors** — If a node agent errors, call \`save_artifact({ type: "result", append: true, summary: "..." })\` ` +
			`to record what went wrong, then \`submit_for_approval\` to escalate to human review. ` +
			`The runtime will classify the task based on the completion-action pipeline; you do not control the final status.`
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

	// ---- Post-approval -------------------------------------------------------
	sections.push(`\n## Post-Approval\n`);
	sections.push(
		`When a task reaches the \`approved\` status (either via end-node \`approve_task\` or ` +
			`human approval of a \`submit_for_approval\` request), the runtime emits a ` +
			`\`[TASK_APPROVED]\` awareness event into your session. This event is informational — ` +
			`it tells you that the task has cleared approval but is **not yet done**.\n` +
			`\n` +
			`Depending on the workflow's \`postApproval\` configuration, one of three things happens next:\n` +
			`1. **No post-approval declared** — the runtime auto-transitions the task \`approved → done\`. ` +
			`You do nothing.\n` +
			`2. **\`targetAgent: 'task-agent'\`** — the runtime injects a \`[POST_APPROVAL_INSTRUCTIONS]\` ` +
			`message into your session containing the workflow's post-approval instructions. ` +
			`Execute them to completion using your tools, then call \`mark_complete\` to transition the ` +
			`task \`approved → done\`. You must call \`mark_complete\` exactly once when the work is finished.\n` +
			`3. **\`targetAgent\` pointing at a node agent** — the runtime spawns a fresh node-agent ` +
			`sub-session to handle the post-approval work. You do nothing; that sub-session will call ` +
			`\`mark_complete\` itself when finished.\n` +
			`\n` +
			`**Key rules:**\n` +
			`- \`mark_complete\` is the ONLY way to transition \`approved → done\`. It fails with a clear ` +
			`error if the task is not in \`approved\` status.\n` +
			`- Do not call \`approve_task\` on a task that is already \`approved\` — that would be a no-op ` +
			`error. If you want to move an approved task to done, call \`mark_complete\`.\n` +
			`- \`[POST_APPROVAL_INSTRUCTIONS]\` arrive as a user-turn message. Treat them as authoritative ` +
			`work to execute; do not ask for human approval before starting.\n` +
			`- If the post-approval work fails, call \`submit_for_approval\` (or surface the error via ` +
			`\`request_human_input\`) rather than swallowing it.`
	);

	// ---- Behavioral rules ---------------------------------------------------
	sections.push(`\n## Behavioral Rules\n`);
	sections.push(
		`These rules govern your behavior as a Task Agent. Violating them is a critical error.\n`
	);
	sections.push(
		`1. **Do not execute code directly.** You are an orchestrator, not an executor. ` +
			`All code execution, file editing, and git operations happen in workflow node sessions. ` +
			`You have no direct access to the filesystem.\n`
	);
	sections.push(
		`2. **Do not bypass human gates.** When a workflow transition requires human approval, ` +
			`you must call \`request_human_input\` and wait. Never assume approval or skip the gate.\n`
	);
	sections.push(
		`3. **Do not make architectural decisions.** The workflow defines the process. ` +
			`If you disagree with a node or transition, surface the concern to the human via ` +
			`\`request_human_input\` — do not silently deviate from the workflow.\n`
	);
	sections.push(
		`4. **Record results accurately.** When calling \`save_artifact\`, include a factual ` +
			`summary of what was accomplished. Do not embellish or speculate.\n`
	);
	sections.push(
		`5. **Do not fabricate workflow state.** Use \`list_group_members\` and inbound events as your ` +
			`source of truth. If state is unclear, summarize uncertainty and ask for human input.`
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
		`The Task Agent has default bidirectional channels to all node agents. ` +
			`Node agents use \`list_reachable_agents\` to discover their full reachability graph.`
	);

	// ---- Task context -------------------------------------------------------
	sections.push(`\n## Task #${context.task.taskNumber} Details\n`);
	sections.push(`**Title:** ${context.task.title}`);
	sections.push(`**Priority:** ${context.task.priority}`);
	sections.push(`**Status:** ${context.task.status}`);
	if (context.task.description) {
		sections.push(`\n**Description:**\n${context.task.description}`);
	}
	if (context.task.dependsOn && context.task.dependsOn.length > 0) {
		sections.push(`\n**Dependencies:** ${context.task.dependsOn.join(', ')}`);
	}

	// ---- Operator-supplied context (appended last so contract sections cannot be overridden) --
	if (context.space.backgroundContext) {
		sections.push(`\n## Space Background\n\n${context.space.backgroundContext}`);
	}

	if (context.space.instructions) {
		sections.push(`\n## Space Instructions\n\n${context.space.instructions}`);
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
 *   2. The full workflow structure (nodes, transitions, conditions, rules)
 *   3. Available agents and their capabilities
 *   4. Previous task results for context continuity
 */
export function buildTaskAgentInitialMessage(context: TaskAgentContext): string {
	const parts: string[] = [];

	// ---- Task assignment -----------------------------------------------------
	parts.push(
		`## Task #${context.task.taskNumber} Assignment\n` +
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
			parts.push(`\n### Nodes (execution order defined by transitions)\n`);
			parts.push(`**Start node:** \`${wf.startNodeId}\`\n`);
			for (const node of wf.nodes) {
				parts.push(formatNode(node, context.availableAgents));
			}
		} else {
			parts.push(`\n_This workflow has no nodes defined._`);
		}

		if (context.workflowRun) {
			const run = context.workflowRun;
			parts.push(`\n### Active Workflow Run\n`);
			parts.push(`**Run ID:** \`${run.id}\``);
			parts.push(`**Run Title:** ${run.title}`);
			if (run.description) {
				parts.push(`**Run Description:** ${run.description}`);
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
			const workflowGates = context.workflow.gates ?? [];
			for (const ch of channels) {
				parts.push(formatChannel(ch, workflowGates));
			}
		} else {
			parts.push(`\n## Collaboration Channel Map\n`);
			parts.push(
				`No channels are declared for this workflow. ` +
					`Agents are fully isolated — \`send_message\` is unavailable unless channels are added.`
			);
		}

		// ---- Gates (M1.1 separated Gate entities) ----------------------------
		const gates = context.workflow.gates;
		if (gates && gates.length > 0) {
			parts.push(`\n## Workflow Gates\n`);
			parts.push(
				`Gates guard channels — a message on a gated channel is held until the gate's condition passes. ` +
					`Node agents use \`list_gates\` and \`read_gate\` tools to inspect gate state. Gate data is written ` +
					`automatically when \`send_message\` is called on a gated channel with a \`data\` parameter.\n` +
					`\n` +
					`**Vote counting:** for \`count\` condition gates, node agents use their \`nodeId\` ` +
					`(workflow node ID) as the map key — each node votes exactly once.\n`
			);
			for (const gate of gates) {
				parts.push(formatGate(gate));
			}
		}
	}

	// ---- Available agents ---------------------------------------------------
	if (context.availableAgents.length > 0) {
		parts.push(`\n## Available Agents\n`);
		for (const agent of context.availableAgents) {
			const desc = agent.description ? ` — ${agent.description}` : '';
			const model = agent.model ? ` (model: ${agent.model})` : '';
			parts.push(`- **${agent.name}** (id: \`${agent.id}\`)${model}${desc}`);
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
	parts.push(
		`Space Runtime has already started workflow execution for this task. ` +
			`Remain in helper mode: summarize status with \`list_group_members\`, route human guidance with \`send_message\`, ` +
			`and request approvals with \`request_human_input\` when needed.`
	);

	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Session init factory
// ---------------------------------------------------------------------------

const DEFAULT_TASK_AGENT_MODEL = 'claude-sonnet-4-6';

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
	};
}
