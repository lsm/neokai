/**
 * Leader Agent Factory - Creates AgentSessionInit for Leader (reviewer) sessions
 *
 * The Leader agent reviews worker output and must call exactly one terminal tool per turn:
 * - send_to_worker(message) - Send feedback for another iteration
 * - complete_task(summary) - Accept work, mark task done
 * - fail_task(reason) - Task is not achievable
 * - replan_goal(reason) - Fail task and trigger replanning with context
 *
 * Leader tools are MCP callbacks that route through the RoomRuntime.
 * The Leader adapts its review focus based on reviewContext:
 * - 'plan_review': Evaluates task breakdown quality, coverage, ordering
 * - 'code_review': Evaluates implementation correctness, completeness
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../agent/agent-session';
import type {
	Room,
	RoomGoal,
	NeoTask,
	SessionFeatures,
	McpServerConfig,
	AgentDefinition,
} from '@neokai/shared';

const DEFAULT_LEADER_MODEL = 'claude-sonnet-4-5-20250929';

const LEADER_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export type ReviewContext = 'plan_review' | 'code_review';

export interface LeaderToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

/**
 * Callback interface for Leader tool routing.
 * The RoomRuntime implements this to handle tool calls.
 */
export interface LeaderToolCallbacks {
	sendToWorker(groupId: string, message: string): Promise<LeaderToolResult>;
	completeTask(groupId: string, summary: string): Promise<LeaderToolResult>;
	failTask(groupId: string, reason: string): Promise<LeaderToolResult>;
	replanGoal(groupId: string, reason: string): Promise<LeaderToolResult>;
	submitForReview(groupId: string, prUrl: string): Promise<LeaderToolResult>;
}

export interface LeaderAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	groupId: string;
	model?: string;
	/** What type of work is being reviewed */
	reviewContext?: ReviewContext;
}

/**
 * Build a system prompt for the Leader agent.
 *
 * Includes goal/task context, review policy, and the tool contract.
 * Adapts review guidelines based on whether reviewing a plan or code.
 */
export function buildLeaderSystemPrompt(config: LeaderAgentConfig): string {
	const { task, goal, room, reviewContext } = config;
	const isPlanReview = reviewContext === 'plan_review';

	const sections: string[] = [];

	if (isPlanReview) {
		sections.push(
			`You are a Leader Agent responsible for reviewing a plan created by a Planner Agent.`
		);
		sections.push(`Your job is to evaluate the task breakdown against the goal requirements.`);
	} else {
		sections.push(`You are a Leader Agent responsible for reviewing work done by a worker agent.`);
		sections.push(`Your job is to evaluate the worker's output against the task requirements.`);
	}

	// Tool contract
	sections.push(`\n## Tool Contract (CRITICAL)\n`);
	sections.push(`You MUST call exactly one tool per turn:`);
	sections.push(`- \`send_to_worker\` — Send feedback if the work needs changes`);
	sections.push(`- \`complete_task\` — Accept the work if it meets all requirements`);
	sections.push(`- \`fail_task\` — Mark the task as not achievable`);
	sections.push(
		`- \`replan_goal\` — The current approach isn't working; fail this task and trigger replanning with context about what was tried`
	);
	sections.push(
		`- \`submit_for_review\` — ONLY after dispatching all reviewer sub-agents and collecting their verdicts. Runtime rejects this if no PR reviews exist. Work is done with a PR ready; free the group slot and park the task for human approval\n`
	);
	sections.push(`Do NOT respond with only text. You MUST call one of the above tools.`);

	// Task context
	sections.push(`\n## Task Under Review\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}

	// Goal context
	sections.push(`\n## Goal Context\n`);
	sections.push(`**Goal:** ${goal.title}`);
	if (goal.description) {
		sections.push(`**Description:** ${goal.description}`);
	}

	// Room review policy
	if (room.instructions) {
		sections.push(`\n## Review Policy\n`);
		sections.push(room.instructions);
	}

	// Handling worker questions
	sections.push(`\n## Handling Worker Questions\n`);
	sections.push(
		`If the worker output shows \`Terminal state: waiting_for_input\`, the worker is asking a question.`
	);
	sections.push(
		`- If you can answer the question from the goal/task context, use \`send_to_worker\` with the answer`
	);
	sections.push(
		`- If the question requires human judgment or information you don't have, use \`fail_task\` with the reason (e.g., "Worker needs human input: <question>")`
	);

	// Context-specific review guidelines
	if (isPlanReview) {
		sections.push(`\n## Plan Review Guidelines\n`);
		sections.push(`1. Check that the plan covers all aspects of the goal`);
		sections.push(`2. Verify each task has clear, specific acceptance criteria`);
		sections.push(`3. Ensure tasks are ordered correctly by dependency`);
		sections.push(`4. Check that tasks are well-scoped (not too broad or too narrow)`);
		sections.push(
			`5. Verify appropriate agent types are assigned (coder for implementation, general for non-coding)`
		);
		sections.push(
			`6. If the plan needs changes, use \`send_to_worker\` with specific feedback on what to add, remove, or modify`
		);
		sections.push(
			`7. If the plan is comprehensive and well-structured, use \`submit_for_review\` to submit it for human approval before execution begins`
		);
		sections.push(
			`8. Do NOT use \`complete_task\` for plans — plans must be reviewed by a human before tasks are promoted`
		);
		sections.push(`9. Use \`fail_task\` only if the goal is fundamentally not plannable`);
		sections.push(
			`10. Use \`replan_goal\` if the plan reveals a flawed approach that needs rethinking`
		);
	} else {
		// Check if room has sub-agents configured for leader
		const roomConfig = room.config ?? {};
		const reviewerConfigs = getLeaderSubagents(roomConfig);
		const hasReviewers = reviewerConfigs && reviewerConfigs.length > 0;

		if (hasReviewers) {
			// Full review orchestration workflow with reviewer sub-agents
			sections.push(`\n## Review Orchestration Workflow (MANDATORY)\n`);
			sections.push(
				`**YOU MUST DISPATCH REVIEWER SUB-AGENTS. DO NOT REVIEW CODE YOURSELF.**\nYour role is to ORCHESTRATE reviews, not to perform them. You MUST use the Task tool\nto spawn each reviewer sub-agent listed below. The runtime will reject submit_for_review\nif no reviews have been posted on the PR.\n`
			);
			sections.push(
				`You have reviewer sub-agents available via the Task tool. You MUST dispatch these reviewers before calling \`complete_task\`. The runtime enforces this — \`complete_task\` will be rejected if no reviews have been posted on the PR.\n`
			);
			sections.push(
				`Each reviewer will thoroughly review the code in this worktree — not just the diff, but the full implementation — to verify the original request was correctly achieved.\n`
			);

			sections.push(`### Step 1: Understand What Was Done`);
			sections.push(`Read the worker's output to understand:`);
			sections.push(`- What was the original request/task?`);
			sections.push(`- What did the worker implement?`);
			sections.push(`- Which files were changed or created?`);
			sections.push(
				`\nExtract the PR number if one was created (look for "PR #123", GitHub PR URLs, or \`gh pr create\` output).`
			);
			sections.push(
				`If no PR was created, use \`send_to_worker\` asking the worker to create one before review can proceed.\n`
			);

			sections.push(`### Step 2: Spawn Reviewer Sub-agents`);
			sections.push(
				`Use the \`Task\` tool to spawn each reviewer. Available reviewers:\n`
			);
			for (const reviewer of reviewerConfigs!) {
				const name = `reviewer-${reviewer.model.replace(/[^a-zA-Z0-9-]/g, '-')}`;
				const type = reviewer.type === 'cli' ? ' (CLI)' : '';
				sections.push(`- **${name}**${type} — Reviews using ${reviewer.model}`);
			}

			sections.push(`\nFor each reviewer, use the Task tool like this:`);
			sections.push('```');
			sections.push(
				`Task(subagent_type: "reviewer-<model-name>", prompt: "Review the code in this worktree for PR #<NUMBER>. The original request was: <task description>. The worker implemented: <summary of what was done>. Review the implementation thoroughly — read the full files, not just diffs — and verify the original request is correctly and completely achieved.")`
			);
			sections.push('```');
			sections.push(
				`\nSpawn all reviewers in parallel by making multiple Task calls in the same turn.`
			);
			sections.push(
				`Each reviewer will review the codebase comprehensively, post findings as PR comments, and return a structured verdict.\n`
			);

			sections.push(`### Step 3: Parse Verdicts`);
			sections.push(
				`Each reviewer returns a verdict block between \`---VERDICT---\` and \`---END_VERDICT---\` markers.`
			);
			sections.push(`Parse each verdict for:\n`);
			sections.push(`- **recommendation**: APPROVE, REQUEST_CHANGES, or COMMENT_ONLY`);
			sections.push(`- **P0**: Blocking — bugs, security vulnerabilities, data loss, broken functionality`);
			sections.push(`- **P1**: Should-fix — poor patterns, missing error handling, test gaps`);
			sections.push(`- **P2**: Important suggestion — meaningful quality/readability improvements`);
			sections.push(`- **P3**: Nit — style issues, minor cosmetic, optional documentation\n`);

			sections.push(`### Step 4: Decide Next Action\n`);
			sections.push(
				`Consolidate all reviewer findings and make ONE decision:\n`
			);
			sections.push(
				`- **Any P0, P1, or P2 issues exist** → use \`send_to_worker\` with consolidated feedback. List each issue with file:line and what to fix. All P0, P1, and P2 issues must be resolved.`
			);
			sections.push(
				`- **Only P3 nits or no issues** → use \`submit_for_review\` with the PR URL to park for human approval.`
			);
			sections.push(
				`- **Task is fundamentally broken** → use \`fail_task\` or \`replan_goal\`.\n`
			);

			sections.push(`### Subsequent Rounds`);
			sections.push(
				`When the worker pushes fixes and you receive their updated output:\n`
			);
			sections.push(
				`1. Resume each reviewer using \`Task(resume: <agentId>)\` — this preserves their prior context`
			);
			sections.push(
				`2. Tell each resumed reviewer: "Fixes have been pushed for PR #<NUMBER>. Please re-review the code and verify your previous findings were addressed. Also check that the fixes didn't introduce new issues."`
			);
			sections.push(
				`3. Parse the new verdicts and decide again.\n`
			);
		} else {
			// Simple review guidelines without coordinator sub-agents
			sections.push(`\n## Review Guidelines\n`);
			sections.push(`1. Check that the implementation matches the task description`);
			sections.push(`2. Verify correctness and completeness`);
			sections.push(
				`3. If issues are found, use \`send_to_worker\` with specific actionable feedback`
			);
			sections.push(
				`4. If the work is complete, correct, and a PR was created, use \`submit_for_review\` with the PR URL`
			);
			sections.push(
				`5. If no PR is needed (non-coding tasks), use \`complete_task\` with a summary`
			);
		}

		sections.push(
			`- Use \`fail_task\` if this specific task is not achievable but the overall plan is still sound`
		);
		sections.push(
			`- Use \`replan_goal\` if the failure reveals the overall approach needs rethinking — this cancels remaining tasks and triggers a fresh plan`
		);
	}

	return sections.join('\n');
}

/**
 * Create testable Leader tool handler functions.
 * These delegate to the provided callbacks which route through RoomRuntime.
 */
export function createLeaderToolHandlers(groupId: string, callbacks: LeaderToolCallbacks) {
	return {
		async send_to_worker(args: { message: string }): Promise<LeaderToolResult> {
			return callbacks.sendToWorker(groupId, args.message);
		},
		async complete_task(args: { summary: string }): Promise<LeaderToolResult> {
			return callbacks.completeTask(groupId, args.summary);
		},
		async fail_task(args: { reason: string }): Promise<LeaderToolResult> {
			return callbacks.failTask(groupId, args.reason);
		},
		async replan_goal(args: { reason: string }): Promise<LeaderToolResult> {
			return callbacks.replanGoal(groupId, args.reason);
		},
		async submit_for_review(args: { pr_url: string }): Promise<LeaderToolResult> {
			return callbacks.submitForReview(groupId, args.pr_url);
		},
	};
}

/**
 * Create an MCP server with Leader review tools.
 * Tool callbacks route through the RoomRuntime via LeaderToolCallbacks.
 */
export function createLeaderMcpServer(groupId: string, callbacks: LeaderToolCallbacks) {
	const handlers = createLeaderToolHandlers(groupId, callbacks);

	const tools = [
		tool(
			'send_to_worker',
			'Send feedback to the worker agent for another iteration of work',
			{
				message: z.string().describe('Specific, actionable feedback for the worker agent'),
			},
			(args) => handlers.send_to_worker(args)
		),
		tool(
			'complete_task',
			'Accept the work and mark the task as completed',
			{
				summary: z
					.string()
					.describe('Summary of what was accomplished and how it meets requirements'),
			},
			(args) => handlers.complete_task(args)
		),
		tool(
			'fail_task',
			'Mark the task as not achievable',
			{
				reason: z.string().describe('Explanation of why the task cannot be completed'),
			},
			(args) => handlers.fail_task(args)
		),
		tool(
			'replan_goal',
			'Fail this task and trigger replanning — use when the overall approach needs rethinking',
			{
				reason: z
					.string()
					.describe('What was tried, what went wrong, and why a different approach is needed'),
			},
			(args) => handlers.replan_goal(args)
		),
		tool(
			'submit_for_review',
			'Work is done with a PR ready — free the group slot and park the task for human approval',
			{
				pr_url: z.string().min(1).describe('The GitHub PR URL for human review'),
			},
			(args) => handlers.submit_for_review(args)
		),
	];

	return createSdkMcpServer({ name: 'leader-agent-tools', tools });
}

/**
 * Sub-agent configuration (used in room.config.agentSubagents.{role})
 * Backward-compatible with the legacy room.config.reviewers format.
 */
interface SubagentConfig {
	/** Model ID (e.g., 'claude-opus-4-6', 'glm-5') or CLI agent ID */
	model: string;
	/** Provider name (e.g., 'anthropic', 'glm') */
	provider?: string;
	/** For CLI-only models: use a driver model that calls the CLI via Bash */
	type?: 'cli';
	/** Model to use as driver when type is 'cli' */
	driver_model?: string;
}

/**
 * Read leader sub-agents from room config.
 * Path: room.config.agentSubagents.leader
 */
function getLeaderSubagents(
	roomConfig: Record<string, unknown>
): SubagentConfig[] | undefined {
	const agentSubagents = roomConfig.agentSubagents as
		| Record<string, SubagentConfig[]>
		| undefined;
	if (agentSubagents?.leader && agentSubagents.leader.length > 0) {
		return agentSubagents.leader;
	}
	// Legacy fallback: room.config.reviewers
	const legacyReviewers = roomConfig.reviewers as SubagentConfig[] | undefined;
	if (legacyReviewers && legacyReviewers.length > 0) {
		return legacyReviewers;
	}
	return undefined;
}

/**
 * Map a full model ID to a valid AgentModel for the SDK.
 * The SDK only accepts: 'sonnet' | 'opus' | 'haiku' | 'inherit'
 */
export function toAgentModel(modelId: string): AgentDefinition['model'] {
	const lower = modelId.toLowerCase();
	if (lower.includes('opus')) return 'opus';
	if (lower.includes('haiku')) return 'haiku';
	if (lower.includes('sonnet')) return 'sonnet';
	// Default to 'sonnet' for unknown models
	return 'sonnet';
}

/** Restricted tools for reviewer sub-agents (read-only + gh CLI) */
const REVIEWER_TOOLS: AgentDefinition['tools'] = [
	'Read',
	'Grep',
	'Glob',
	'Bash',
	'WebFetch',
	'WebSearch',
];

const REVIEWER_VERDICT_FORMAT = `
## Required Output Format

You MUST end your response with a structured verdict in exactly this format:

---VERDICT---
issues_found: <number>
recommendation: APPROVE | REQUEST_CHANGES | COMMENT_ONLY
p0:
- <file:line> <description of blocking issue>
p1:
- <file:line> <description of should-fix issue>
p2:
- <file:line> <description of important suggestion>
p3:
- <file:line> <description of minor nit>
---END_VERDICT---

Severity levels:
- P0 (blocking): Bugs, security vulnerabilities, data loss risks, broken functionality
- P1 (should-fix): Poor patterns, missing error handling, test gaps, unclear code
- P2 (important suggestion): Meaningful improvements to quality, readability, maintainability
- P3 (nit): Style nits, minor cosmetic issues, optional documentation

Decision rules:
- Use "REQUEST_CHANGES" when any P0, P1, or P2 issues exist — all must be addressed
- Use "APPROVE" when only P3 issues or no issues exist
- Use "COMMENT_ONLY" when you only have P3 nits and the code is otherwise good
- List "none" under a severity level if there are no issues at that level`;

/**
 * Build prompt for an SDK-native reviewer agent (reviews code directly).
 */
function buildSdkReviewerPrompt(): string {
	return `You are a thorough code reviewer. Your job is to review the codebase in this worktree to verify that the requested work was correctly implemented.

## Review Process

1. Read the task prompt carefully — it describes what was requested and what was implemented
2. Understand the original ask: what was the goal? What should the final result look like?
3. Explore the codebase thoroughly (use Read, Grep, Glob to understand the full picture):
   - Read the changed/new files completely, not just diffs
   - Read surrounding code to understand integration points
   - Check imports, exports, and cross-file dependencies
   - Look at test files to verify coverage
4. Evaluate the implementation holistically:
   - **Correctness**: Does the code actually achieve the original ask?
   - **Completeness**: Are all aspects of the request addressed? Any missing pieces?
   - **Bugs & edge cases**: Logic errors, off-by-one, null handling, race conditions
   - **Security**: Injection, XSS, SSRF, path traversal, auth bypass, data exposure
   - **Architecture**: Does this fit the existing patterns? Any unnecessary coupling?
   - **Error handling**: Are failures handled gracefully at system boundaries?
   - **Tests**: Do tests actually verify the new behavior? Are edge cases covered?
   - **Over-engineering**: Is there unnecessary complexity, dead code, or premature abstraction?
5. Post your review as a PR comment using: gh pr comment <PR_NUMBER> --body "<review>"
6. Return your verdict in the structured format below

## Guidelines

- Review the code as a whole, not just the diff — understand how changes integrate with the existing codebase
- Verify the original request is fully achieved, not just partially implemented
- Be constructive and specific — always include file paths and line numbers
- Focus on issues that matter — don't nitpick formatting or style if a linter handles it
- Check that tests actually test the new/changed behavior, not just exist
${REVIEWER_VERDICT_FORMAT}`;
}

/**
 * Build prompt for a CLI-based reviewer agent (drives an external CLI tool).
 */
function buildCliReviewerPrompt(cliTool: string): string {
	return `You are a code reviewer that uses the ${cliTool} CLI tool to perform thorough code review.

## Review Process

1. Read the task prompt carefully — it describes what was requested and what was implemented
2. Understand the original ask: what was the goal? What should the final result look like?
3. Explore the codebase to identify changed and related files (use Read, Grep, Glob)
4. Run the ${cliTool} CLI tool via Bash to review the code:
   - Pass the relevant files or directories as input
   - Capture the tool's output
5. Supplement the CLI tool's output with your own review:
   - Read surrounding code to understand integration points
   - Verify the original request is fully achieved
   - Check for issues the CLI tool may have missed
6. Post findings as a PR comment using: gh pr comment <PR_NUMBER> --body "<review>"
7. Return your verdict in the structured format below

## Guidelines

- Map the CLI tool's output to severity levels (P0/P1/P2/P3)
- Add context from the codebase if the tool's findings need clarification
- Review comprehensively — don't limit yourself to just what the CLI tool found
- Be specific about file paths and line numbers
${REVIEWER_VERDICT_FORMAT}`;
}

/**
 * Build reviewer AgentDefinition records from sub-agent configs.
 * Each sub-agent becomes a named agent the leader can spawn via Task tool.
 */
export function buildReviewerAgents(
	reviewers: SubagentConfig[]
): Record<string, AgentDefinition> {
	const agents: Record<string, AgentDefinition> = {};

	for (const reviewer of reviewers) {
		const name = `reviewer-${reviewer.model.replace(/[^a-zA-Z0-9-]/g, '-')}`;

		if (reviewer.type === 'cli') {
			// CLI-based reviewer: a driver model calls the external tool via Bash
			agents[name] = {
				description: `Code reviewer using ${reviewer.model} CLI. Runs the CLI tool via Bash and posts findings as PR comments.`,
				tools: REVIEWER_TOOLS,
				model: toAgentModel(reviewer.driver_model ?? 'sonnet'),
				prompt: buildCliReviewerPrompt(reviewer.model),
			};
		} else {
			// Direct SDK reviewer: uses the specified model natively
			agents[name] = {
				description: `Code reviewer using ${reviewer.model}. Reviews code changes for correctness, quality, and security.`,
				tools: REVIEWER_TOOLS,
				model: toAgentModel(reviewer.model),
				prompt: buildSdkReviewerPrompt(),
			};
		}
	}

	return agents;
}

/**
 * Create an AgentSessionInit for a Leader agent session.
 *
 * Uses the agent/agents pattern: the Leader is defined as a named AgentDefinition
 * and the session is configured with `agent: 'Leader'` to designate it as the main thread.
 * Reviewer sub-agents (if configured) are merged into the `agents` map alongside Leader.
 *
 * This is analogous to coordinatorMode but custom: we define the Leader agent explicitly
 * rather than using the SDK's built-in coordinator. This preserves the leader's system
 * prompt and MCP tools while still allowing sub-agent dispatch via the Task tool.
 *
 * DESIGN NOTE: The Leader agent definition includes built-in tools (Task, Read, etc.)
 * but NOT MCP tools (leader-agent-tools__send_to_worker, etc.). MCP tools are provided
 * via the mcpServers config and should be available to the main agent thread regardless
 * of the agent's tools list. If this assumption is wrong and MCP tools are NOT available,
 * add 'leader-agent-tools__*' to the Leader agent's tools array.
 *
 * To test: Run the server, create a room with reviewer sub-agents configured,
 * trigger autonomous mode, and verify:
 * 1. Leader can call MCP tools (send_to_worker, complete_task, etc.)
 * 2. Leader can dispatch reviewer sub-agents via Task tool
 */
export function createLeaderAgentInit(
	config: LeaderAgentConfig,
	callbacks: LeaderToolCallbacks
): AgentSessionInit {
	const mcpServer = createLeaderMcpServer(config.groupId, callbacks);

	// Build reviewer agents from room config (if any)
	const roomConfig = config.room.config ?? {};
	const reviewerConfigs = getLeaderSubagents(roomConfig);
	const reviewerAgents =
		reviewerConfigs && reviewerConfigs.length > 0
			? buildReviewerAgents(reviewerConfigs)
			: undefined;

	// Only define the Leader agent definition and use agent/agents pattern
	// when there are reviewer sub-agents to dispatch. Otherwise, use the simple
	// preset path to avoid unnecessary complexity.
	if (reviewerAgents) {
		// Build the Leader agent definition that describes its role and tools
		const leaderAgentDef: AgentDefinition = {
			description:
				'Lead reviewer that orchestrates code review. Dispatches reviewer sub-agents, consolidates their findings, and makes routing decisions using MCP tools.',
			prompt: buildLeaderSystemPrompt(config),
			tools: [
				'Task',
				'TaskOutput',
				'TaskStop', // For dispatching reviewer sub-agents
				'Read',
				'Grep',
				'Glob',
				'Bash', // For reading code
				'WebFetch',
				'WebSearch', // For reference lookups
				// NOTE: MCP tools (leader-agent-tools__*) are provided via mcpServers
				// and should be available regardless of this tools list.
			],
			model: toAgentModel(config.model ?? DEFAULT_LEADER_MODEL),
		};

		// Combine Leader + reviewer agents into a single agents map
		const allAgents: Record<string, AgentDefinition> = {
			Leader: leaderAgentDef,
			...reviewerAgents,
		};

		return {
			sessionId: config.sessionId,
			workspacePath: config.workspacePath,
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
			},
			mcpServers: {
				'leader-agent-tools': mcpServer as unknown as McpServerConfig,
			},
			features: LEADER_FEATURES,
			context: { roomId: config.room.id },
			type: 'leader',
			model: config.model ?? DEFAULT_LEADER_MODEL,
			// Use agent/agents pattern: designate Leader as main thread
			// This enables sub-agent dispatch via Task tool without coordinatorMode
			// The Leader's system prompt comes from the agent definition's `prompt` field,
			// not the top-level systemPrompt, to avoid the claude_code preset drowning it out.
			agent: 'Leader',
			agents: allAgents,
		};
	}

	// Simple path: no reviewer sub-agents, no agent/agents needed
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildLeaderSystemPrompt(config),
		},
		mcpServers: {
			'leader-agent-tools': mcpServer as unknown as McpServerConfig,
		},
		features: LEADER_FEATURES,
		context: { roomId: config.room.id },
		type: 'leader',
		model: config.model ?? DEFAULT_LEADER_MODEL,
	};
}
