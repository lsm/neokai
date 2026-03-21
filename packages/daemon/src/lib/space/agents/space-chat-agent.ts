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
		`**Use \`create_task\`** for standalone work that needs no multi-step orchestration:\n` +
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
			`orchestrate task creation. Only use \`create_task\` for explicitly standalone work.`
	);

	return sections.join('\n');
}
