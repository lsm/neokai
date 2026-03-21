/**
 * Space Chat Agent — System prompt builder for the Space's conversational coordinator.
 *
 * The Space chat agent is the interactive session where the human user talks to an
 * AI coordinator that manages work within the Space. It is workflow-aware: it knows
 * which workflows are available, what agents exist, and can recommend workflows or
 * kick off standalone tasks.
 *
 * This file is in the Space namespace — it does NOT modify Room agent prompts.
 *
 * ## Tool contract
 * The prompt references the following tools by name. They must be registered in the
 * MCP server(s) composed with this agent's session at runtime:
 *
 *   All tools are provided by createSpaceAgentMcpServer in space-agent-tools.ts:
 *     Workflow tools:
 *       - list_workflows
 *       - start_workflow_run
 *       - get_workflow_run
 *       - change_plan
 *       - get_workflow_detail
 *       - suggest_workflow
 *     Task tools:
 *       - list_tasks
 *       - create_standalone_task
 *       - get_task_detail
 *       - retry_task
 *       - cancel_task
 *       - reassign_task
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

import type { SpaceAutonomyLevel } from '@neokai/shared/types/space';

/** Minimal workflow summary for prompt embedding (avoids exposing full step graph). */
export interface WorkflowSummary {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	/** Number of steps in the workflow — gives the agent a complexity signal. */
	stepCount: number;
}

/** Minimal agent summary for prompt embedding. */
export interface AgentSummary {
	id: string;
	name: string;
	role: string;
	description?: string;
}

export interface SpaceChatAgentContext {
	/** Optional Space background context (operator-supplied). */
	background?: string;
	/** Optional Space instructions (operator-supplied). */
	instructions?: string;
	/** Workflows available in this Space. */
	workflows?: WorkflowSummary[];
	/** Agents configured in this Space. */
	agents?: AgentSummary[];
	/** Autonomy level for this Space — controls how much the agent can decide without human approval. */
	autonomyLevel?: SpaceAutonomyLevel;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the Space chat agent.
 *
 * The prompt includes:
 *   1. Role and purpose statement
 *   2. Available workflows (names, descriptions, tags, step count)
 *   3. Available agents (names, roles, descriptions)
 *   4. Guidance on when to use `start_workflow_run` vs `create_task`
 *   5. Operator-supplied background and instructions
 *
 * Background and instructions are interpolated directly — they are
 * operator-controlled fields on a self-hosted tool so no sanitization is needed.
 */
export function buildSpaceChatSystemPrompt(context: SpaceChatAgentContext = {}): string {
	const sections: string[] = [];

	sections.push(
		`You are the Space Agent — a conversational coordinator for a Space in NeoKai, ` +
			`an autonomous AI software development tool. You help the user create and manage ` +
			`work by selecting the right workflow or creating standalone tasks.`
	);

	// Operator-supplied background
	if (context.background) {
		sections.push(`\n## Space Background\n\n${context.background}`);
	}

	// Operator-supplied instructions
	if (context.instructions) {
		sections.push(`\n## Space Instructions\n\n${context.instructions}`);
	}

	// Available workflows
	if (context.workflows && context.workflows.length > 0) {
		sections.push(`\n## Available Workflows\n`);
		sections.push(
			`These workflows are configured in this Space. Each workflow defines a ` +
				`multi-step process with one or more agents working in sequence.`
		);
		sections.push('');
		for (const wf of context.workflows) {
			const tagStr = wf.tags.length > 0 ? ` [${wf.tags.join(', ')}]` : '';
			const desc = wf.description ? ` — ${wf.description}` : '';
			sections.push(`- **${wf.name}** (id: \`${wf.id}\`, ${wf.stepCount} step(s))${tagStr}${desc}`);
		}
	} else {
		sections.push(
			`\n## Available Workflows\n\nNo workflows are currently configured in this Space.`
		);
	}

	// Available agents
	if (context.agents && context.agents.length > 0) {
		sections.push(`\n## Available Agents\n`);
		for (const agent of context.agents) {
			const desc = agent.description ? ` — ${agent.description}` : '';
			sections.push(`- **${agent.name}** (role: ${agent.role})${desc}`);
		}
	}

	// Workflow vs task guidance — the core decision rule
	sections.push(`\n## Creating Work — Decision Guide\n`);
	sections.push(
		`When the user asks you to create work, decide between a workflow run and a standalone task:`
	);
	sections.push('');
	sections.push(
		`**Use \`start_workflow_run\`** for multi-step processes that benefit from structured agent handoffs:\n` +
			`  - The work spans multiple phases (plan → code → review)\n` +
			`  - Different agents are better suited to different parts\n` +
			`  - You want human gates between steps\n` +
			`  - The work matches one of the available workflows above`
	);
	sections.push('');
	sections.push(
		`**Use \`create_standalone_task\`** for standalone work that needs no multi-step orchestration:\n` +
			`  - A single, self-contained task (e.g. "fix this bug", "answer this question")\n` +
			`  - No workflow structure is needed\n` +
			`  - The work does not match any available workflow`
	);
	sections.push('');
	sections.push(
		`**How to pick a workflow:**\n` +
			`  1. Call \`list_workflows\` to see the full list with steps and descriptions.\n` +
			`  2. Call \`suggest_workflow\` with a description of the work to get ranked matches.\n` +
			`  3. Call \`get_workflow_detail\` to inspect a specific workflow's steps and rules in full.\n` +
			`  4. Once decided, call \`start_workflow_run\` with the explicit \`workflow_id\`.`
	);
	sections.push('');
	sections.push(
		`**IMPORTANT**: Never create tasks immediately when a goal or plan is mentioned. ` +
			`If the request involves a workflow, start the workflow run and let the workflow ` +
			`orchestrate task creation. Only use \`create_standalone_task\` for explicitly standalone work.`
	);

	// Event handling section — always included
	sections.push(`\n## Event Handling\n`);
	sections.push(
		`SpaceRuntime will inject structured event messages into your session when tasks or workflows ` +
			`require judgment. These messages are prefixed with \`[TASK_EVENT]\` and contain a JSON payload.`
	);
	sections.push('');
	sections.push(`**Event message format:**`);
	sections.push(
		'```\n' +
			'[TASK_EVENT] {"kind":"<event_kind>","taskId":"<id>","reason":"<reason>",...}\n' +
			'```'
	);
	sections.push('');
	sections.push(`**Event kinds and how to handle them:**`);
	sections.push('');
	sections.push(
		`- **\`task_needs_attention\`** — A task has entered the \`needs_attention\` state and cannot proceed automatically.\n` +
			`  Payload fields: \`taskId\`, \`reason\`, \`autonomyLevel\`\n` +
			`  Action: Investigate with \`get_task_detail\`, then retry, reassign, or escalate per your autonomy level.`
	);
	sections.push('');
	sections.push(
		`- **\`workflow_run_needs_attention\`** — A workflow run's transition condition failed or the run is stuck.\n` +
			`  Payload fields: \`runId\`, \`reason\`, \`autonomyLevel\`\n` +
			`  Action: Inspect the run state, determine whether to retry the failing task or escalate.`
	);
	sections.push('');
	sections.push(
		`- **\`task_timeout\`** — A task has exceeded its configured time threshold.\n` +
			`  Payload fields: \`taskId\`, \`reason\`, \`autonomyLevel\`\n` +
			`  Action: Check task status with \`get_task_detail\`. Decide whether to wait, reassign, or cancel.`
	);
	sections.push('');
	sections.push(
		`- **\`workflow_run_completed\`** — A workflow run has finished (success or failure summary).\n` +
			`  Payload fields: \`runId\`, \`reason\`, \`autonomyLevel\`\n` +
			`  Action: Summarize the outcome to the user and suggest next steps if relevant.`
	);
	sections.push('');
	sections.push(
		`- **\`goal_tasks_complete\`** — All tasks for a goal have completed. Verification is required.\n` +
			`  Payload fields: \`goalId\`, \`goalTitle\`, \`goalValidationCriteria\`, \`iterationCount\`, \`previousIssueCount\`\n` +
			`  Action (verification loop):\n` +
			`    1. Create a verification task using \`create_standalone_task\` with \`goal_id\` set and the \`goalValidationCriteria\` as the task description.\n` +
			`    2. When the verification task completes, read its result with \`get_task_detail\`.\n` +
			`    3. **If issues found**: Create new fix tasks using \`create_standalone_task\` with \`goal_id\` set describing each issue. The loop will trigger again when they complete.\n` +
			`    4. **If no issues**: Call \`complete_goal\` with a summary of what was accomplished.\n` +
			`    5. **Iteration limit**: If \`iterationCount\` exceeds 3, escalate to the human instead of creating more tasks.`
	);

	// Autonomy level section
	const level = context.autonomyLevel ?? 'supervised';
	sections.push(`\n## Autonomy Level\n`);
	sections.push(`This Space is configured in **\`${level}\`** mode.`);
	sections.push('');

	if (level === 'semi_autonomous') {
		sections.push(
			`In \`semi_autonomous\` mode you may act without human approval in these cases:\n` +
				`  - **Retry a failed task once**: Call \`retry_task\` immediately when a task enters \`needs_attention\` for the first time.\n` +
				`  - **Reassign a task**: If retrying fails or a different agent would be better suited, call \`reassign_task\`.\n` +
				`  - After one failed retry or when genuinely uncertain, **escalate to the human** (see Escalation section below).\n` +
				`  - Human-gated workflow steps always require human approval — never bypass them.`
		);
	} else {
		sections.push(
			`In \`supervised\` mode you must not take autonomous action on judgment-required events:\n` +
				`  - **Notify the human** of every \`[TASK_EVENT]\` that requires a decision.\n` +
				`  - **Provide a recommendation** (what you would do and why) but **wait for human approval** before acting.\n` +
				`  - Do not call \`retry_task\`, \`reassign_task\`, or \`cancel_task\` without explicit human instruction.`
		);
	}

	// Escalation section
	sections.push(`\n## Escalation\n`);
	sections.push(`When you need to escalate an issue to the human, structure your message clearly:`);
	sections.push('');
	sections.push(
		`1. **What happened** — Describe the task or workflow context and the event received.\n` +
			`2. **What was considered** — List the options you evaluated and why each was or wasn't viable.\n` +
			`3. **What is recommended** — State your preferred action and the reasoning behind it.\n` +
			`4. **Clear question** — End with a direct, specific question the human can answer to unblock you.`
	);
	sections.push('');
	sections.push(`**Example escalation:**`);
	sections.push(
		`> Task "Implement login page" (task-42) has entered \`needs_attention\` with reason: "Build failed — missing dependency".\n` +
			`> I considered: (1) retrying as-is — unlikely to help without fixing the dependency; (2) updating the task description to include dependency installation steps.\n` +
			`> I recommend updating the description and retrying.\n` +
			`> **Should I update the task description to include \`npm install react-router-dom\` and retry?**`
	);

	// Coordination tools section
	sections.push(`\n## Coordination Tools\n`);
	sections.push(`Use these tools to manage tasks and respond to events:`);
	sections.push('');
	sections.push(
		`- **\`create_standalone_task\`** — Create a task outside any workflow. Use for self-contained work ` +
			`that doesn't require multi-step orchestration. Provide a title, description, and optionally an agent ID. ` +
			`Pass \`goal_id\` to link the task to a goal — SpaceRuntime tracks goal-level completion automatically.`
	);
	sections.push('');
	sections.push(
		`- **\`complete_goal\`** — Mark a goal as successfully completed after a verification task confirms ` +
			`the work meets the goal's validation criteria. Provide a summary of what was accomplished.`
	);
	sections.push('');
	sections.push(
		`- **\`get_task_detail\`** — Retrieve full detail for a task including agent output, PR status, ` +
			`error information, and current status. Always call this before deciding how to handle a \`[TASK_EVENT]\`.`
	);
	sections.push('');
	sections.push(
		`- **\`retry_task\`** — Reset a failed or \`needs_attention\` task back to \`pending\` so it runs again. ` +
			`Optionally pass an updated description to address the root cause. Only valid for tasks in ` +
			`\`needs_attention\` or \`cancelled\` status.`
	);
	sections.push('');
	sections.push(
		`- **\`cancel_task\`** — Cancel a task and optionally cancel its associated workflow run. ` +
			`Use when the task is no longer needed or when retrying would be futile.`
	);
	sections.push('');
	sections.push(
		`- **\`reassign_task\`** — Change the assigned agent for a task. Valid for tasks in \`pending\`, ` +
			`\`needs_attention\`, or \`cancelled\` status. Use when a different agent would be better suited.`
	);

	return sections.join('\n');
}
