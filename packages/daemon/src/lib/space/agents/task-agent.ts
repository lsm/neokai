/**
 * Task Agent — System prompt builder for Task Agent sessions.
 *
 * The Task Agent is a workflow orchestrator that manages the execution of a
 * specific Space task. It spawns sub-sessions for each workflow step, monitors
 * their completion, advances the workflow, and surfaces human gates to the user.
 *
 * ## Behavioral contract
 * - The Task Agent does NOT execute code directly — it delegates to step agents.
 * - It does NOT bypass human gates — it surfaces them and waits.
 * - It does NOT make architectural decisions — the workflow defines the process.
 *
 * ## Tool contract
 * The prompt references the following MCP tools by name. They must be registered
 * in the MCP server(s) composed with this agent's session at runtime:
 *
 *   - spawn_step_agent      — Start a sub-session for a workflow step's assigned agent
 *   - check_step_status     — Poll the status/output of a running step agent session
 *   - advance_workflow      — Evaluate transitions from the current step and move to next
 *   - report_result         — Mark the task complete/failed and record the result summary
 *   - request_human_input   — Surface a human gate and block until the user responds
 */

import type {
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	Space,
	SpaceAgent,
	WorkflowStep,
	WorkflowTransition,
	WorkflowRule,
} from '@neokai/shared';

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

function formatStep(step: WorkflowStep, agents: SpaceAgent[]): string {
	const agent = agents.find((a) => a.id === step.agentId);
	const agentLabel = agent ? `${agent.name} (role: ${agent.role})` : `agent id: ${step.agentId}`;
	const instructions = step.instructions ? `\n    Instructions: ${step.instructions}` : '';
	return `- **${step.name}** (id: \`${step.id}\`, assigned to: ${agentLabel})${instructions}`;
}

function formatTransition(t: WorkflowTransition): string {
	const condition = t.condition
		? t.condition.type === 'human'
			? ' [HUMAN GATE]'
			: t.condition.type === 'condition'
				? ` [condition: ${t.condition.expression ?? '?'}]`
				: ''
		: '';
	return `- \`${t.from}\` → \`${t.to}\`${condition}`;
}

function formatRule(rule: WorkflowRule): string {
	const scope =
		rule.appliesTo && rule.appliesTo.length > 0
			? ` (steps: ${rule.appliesTo.join(', ')})`
			: ' (all steps)';
	return `- **${rule.name}**${scope}: ${rule.content}`;
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
		`You are a Task Agent — a workflow orchestrator that manages the execution of a ` +
			`specific task within NeoKai, an autonomous AI software development tool.\n` +
			`\n` +
			`Your job is to drive the assigned task to completion by:\n` +
			`1. Running the task's workflow — spawning sub-sessions for each step's assigned agent\n` +
			`2. Monitoring step completion and advancing the workflow to the next step\n` +
			`3. Surfacing human gates when encountered and waiting for approval before continuing\n` +
			`4. Reporting the final result when the workflow reaches a terminal step`
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
		`- **spawn_step_agent** — Start a sub-session for the current workflow step. ` +
			`Pass the \`step_id\` and optional override instructions. ` +
			`Returns a \`session_id\` for the spawned sub-session. ` +
			`Call this when advancing to a new step that requires agent execution.`
	);
	sections.push(
		`- **check_step_status** — Poll the status and output of a running step agent session. ` +
			`Pass the \`session_id\` returned by \`spawn_step_agent\`. ` +
			`Returns the session's current status (\`running\`, \`completed\`, \`error\`) and output. ` +
			`Call this to determine when a step has finished before advancing.`
	);
	sections.push(
		`- **advance_workflow** — Evaluate transitions from the current workflow step and move ` +
			`to the next step. Pass the \`result\` of the completed step. ` +
			`Returns the next step ID (or indicates terminal state / human gate). ` +
			`Call this after a step agent completes successfully.`
	);
	sections.push(
		`- **report_result** — Mark the task as completed or failed and record a result summary. ` +
			`Pass \`status\` (\`completed\` or \`failed\`) and a \`summary\` string. ` +
			`Call this when the workflow reaches a terminal step or an unrecoverable error occurs.`
	);
	sections.push(
		`- **request_human_input** — Surface a human gate and block until the human responds. ` +
			`Pass a \`prompt\` describing what decision or approval is needed. ` +
			`Returns the human's response. ` +
			`Call this when \`advance_workflow\` returns a \`human\` gate condition.`
	);

	// ---- Workflow execution instructions ------------------------------------
	sections.push(`\n## Workflow Execution Instructions\n`);
	sections.push(`Follow this execution loop until the workflow reaches a terminal state:\n`);
	sections.push(
		`1. **Start the first step** — Call \`spawn_step_agent\` for the workflow's start step.\n` +
			`2. **Monitor completion** — Call \`check_step_status\` periodically until the step reaches ` +
			`a terminal state (\`completed\` or \`error\`).\n` +
			`3. **Advance the workflow** — Call \`advance_workflow\` with the step's result.\n` +
			`   - If it returns a next step ID, go back to step 1 with the new step.\n` +
			`   - If it returns a **human gate**, call \`request_human_input\` to get approval, then ` +
			`resume from step 3.\n` +
			`   - If it returns **terminal** (no outgoing transitions), call \`report_result\` to ` +
			`complete the task.\n` +
			`4. **Handle errors** — If a step agent errors, call \`report_result\` with ` +
			`\`status: "failed"\` and the error details.`
	);

	// ---- Human gate handling -------------------------------------------------
	sections.push(`\n## Human Gate Handling\n`);
	sections.push(
		`When \`advance_workflow\` returns a human gate condition:\n` +
			`1. Call \`request_human_input\` with a clear description of the decision needed.\n` +
			`2. Wait — do not proceed until the tool returns the human's response.\n` +
			`3. Use the human's response to decide which transition to take (if multiple exist).\n` +
			`4. Call \`advance_workflow\` again with the human's decision as the result.\n` +
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
			`step agents via \`spawn_step_agent\`. You have no direct access to the filesystem.\n`
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
		`5. **One step at a time.** Do not spawn multiple step agents concurrently unless the ` +
			`workflow explicitly defines parallel steps. Follow the linear execution loop above.`
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

		if (wf.steps.length > 0) {
			parts.push(`\n### Steps (execution order defined by transitions)\n`);
			parts.push(`**Start step:** \`${wf.startStepId}\`\n`);
			for (const step of wf.steps) {
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
			if (run.currentStepId) {
				const currentStep = wf.steps.find((s) => s.id === run.currentStepId);
				const stepName = currentStep ? currentStep.name : run.currentStepId;
				parts.push(`**Current Step:** ${stepName} (\`${run.currentStepId}\`)`);
			}
		}
	} else {
		parts.push(
			`\n## Workflow\n\n` +
				`No workflow is assigned to this task. Execute the task directly using the ` +
				`most appropriate agent from the available agents list below.`
		);
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
	if (context.workflow && context.workflow.steps.length > 0) {
		parts.push(
			`Begin executing the workflow now. Start by calling \`spawn_step_agent\` ` +
				`for the start step (\`${context.workflow.startStepId}\`).`
		);
	} else {
		parts.push(
			`Begin executing the task now. Spawn the most appropriate agent using ` +
				`\`spawn_step_agent\` and monitor its completion.`
		);
	}

	return parts.join('\n');
}
