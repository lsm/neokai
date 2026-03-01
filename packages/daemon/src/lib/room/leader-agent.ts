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
		`- \`submit_for_review\` — Work is done with a PR ready; free the group slot and park the task for human approval\n`
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
			`7. If the plan is comprehensive and well-structured, use \`complete_task\` with a summary`
		);
		sections.push(`8. Use \`fail_task\` only if the goal is fundamentally not plannable`);
		sections.push(
			`9. Use \`replan_goal\` if the plan reveals a flawed approach that needs rethinking`
		);
	} else {
		// Check if room has reviewer agents configured
		const roomConfig = room.config ?? {};
		const reviewerConfigs = roomConfig.reviewers as ReviewerConfig[] | undefined;
		const hasReviewers = reviewerConfigs && reviewerConfigs.length > 0;

		if (hasReviewers) {
			// Full review orchestration workflow with coordinator sub-agents
			sections.push(`\n## Review Orchestration Workflow\n`);
			sections.push(
				`You are running in coordinator mode with reviewer sub-agents. Follow this workflow:\n`
			);
			sections.push(`### Step 1: Review Worker Output`);
			sections.push(`Read the worker's output to understand what was implemented.`);
			sections.push(`Check if the worker created a PR (look for PR URL in the output).\n`);

			sections.push(`### Step 2: Spawn Reviewer Sub-agents`);
			sections.push(
				`Use the \`Task\` tool to spawn each reviewer sub-agent. Available reviewers:`
			);
			for (const reviewer of reviewerConfigs!) {
				const name = `reviewer-${reviewer.model.replace(/[^a-zA-Z0-9-]/g, '-')}`;
				sections.push(`- \`${name}\` — ${reviewer.model} reviewer`);
			}
			sections.push(
				`\nTell each reviewer the PR number/URL and ask them to review the changes and post findings as PR comments using \`gh pr comment\`.`
			);
			sections.push(
				`Each reviewer should return a structured verdict with issues by severity: P0 (blocking), P1 (should-fix), P2 (suggestion).\n`
			);

			sections.push(`### Step 3: Evaluate Verdicts`);
			sections.push(
				`Collect all reviewer verdicts. Consolidate findings by severity:\n`
			);
			sections.push(`- **P0 (blocking):** Must be fixed before merging`);
			sections.push(`- **P1 (should-fix):** Should be fixed, may warrant sending back`);
			sections.push(`- **P2 (suggestion):** Nice-to-have, don't block on these\n`);

			sections.push(`### Step 4: Decide Next Action`);
			sections.push(
				`- If P0/P1 issues exist: use \`send_to_worker\` with consolidated, actionable feedback`
			);
			sections.push(
				`- If only P2 or no issues: use \`submit_for_review\` with the PR URL to park for human approval`
			);
			sections.push(
				`- If the task is fundamentally broken: use \`fail_task\` or \`replan_goal\`\n`
			);

			sections.push(`### Subsequent Rounds`);
			sections.push(
				`When the worker pushes fixes and you receive their output again:`
			);
			sections.push(
				`- Use \`Task(resume: <agentId>)\` to continue each reviewer's session with full prior context preserved`
			);
			sections.push(
				`- Tell the resumed reviewer: "Fixes have been pushed. Please re-review the changes."`
			);
			sections.push(
				`- This is more efficient than spawning new reviewers — they remember previous findings.\n`
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
				`4. If the work is complete and correct, use \`complete_task\` with a summary`
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
				pr_url: z.string().describe('The GitHub PR URL for human review'),
			},
			(args) => handlers.submit_for_review(args)
		),
	];

	return createSdkMcpServer({ name: 'leader-agent-tools', tools });
}

/**
 * Reviewer configuration from Room.config.reviewers
 */
interface ReviewerConfig {
	/** Model ID (e.g., 'claude-opus-4-6', 'glm-5') */
	model: string;
	/** Provider name (e.g., 'anthropic', 'glm') */
	provider?: string;
	/** For CLI-only models: use a driver model that calls the CLI via Bash */
	type?: 'cli';
	/** Model to use as driver when type is 'cli' */
	driver_model?: string;
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

/**
 * Build reviewer AgentDefinition records from Room.config.reviewers.
 * Each reviewer becomes a named sub-agent the leader can spawn via Task tool.
 */
export function buildReviewerAgents(
	reviewers: ReviewerConfig[]
): Record<string, AgentDefinition> {
	const agents: Record<string, AgentDefinition> = {};

	for (const reviewer of reviewers) {
		const name = `reviewer-${reviewer.model.replace(/[^a-zA-Z0-9-]/g, '-')}`;

		if (reviewer.type === 'cli') {
			// CLI-based reviewer: a driver model calls the external tool via Bash
			agents[name] = {
				description: `Code reviewer using ${reviewer.model} CLI. Runs the CLI tool via Bash and posts findings as PR comments.`,
				tools: REVIEWER_TOOLS,
				model: (reviewer.driver_model ?? 'sonnet') as AgentDefinition['model'],
				prompt: `You are a code reviewer that uses the ${reviewer.model} CLI tool.

1. Run the ${reviewer.model} tool via Bash to review the code changes
2. Parse the output for issues and suggestions
3. Post findings as a PR comment using: gh pr comment <PR_NUMBER> --body "<review>"
4. Return a structured verdict: list issues by severity (P0=blocking, P1=should-fix, P2=suggestion)

Be specific about file paths and line numbers. Distinguish critical issues from minor suggestions.`,
			};
		} else {
			// Direct SDK reviewer: uses the specified model natively
			agents[name] = {
				description: `Code reviewer using ${reviewer.model}. Reviews code changes for correctness, quality, and security.`,
				tools: REVIEWER_TOOLS,
				model: reviewer.model as AgentDefinition['model'],
				prompt: `You are a code reviewer. Your job is to review code changes for correctness, quality, security, and adherence to best practices.

When given a task:
1. Read the changed files carefully (use Read, Grep, Glob to examine the codebase)
2. Check for bugs, logic errors, and edge cases
3. Look for security issues (injection, XSS, etc.)
4. Verify the changes follow existing patterns
5. Check for unnecessary complexity or over-engineering
6. Post your review as a PR comment using: gh pr comment <PR_NUMBER> --body "<review>"
7. Return a structured verdict: list issues by severity (P0=blocking, P1=should-fix, P2=suggestion)

Be constructive and specific. Include file paths and line numbers.`,
			};
		}
	}

	return agents;
}

/**
 * Create an AgentSessionInit for a Leader agent session.
 *
 * Uses the Claude Code preset (for read/glob/grep codebase access to review work)
 * plus leader-specific MCP tools for routing decisions.
 *
 * When Room.config.reviewers is configured, enables coordinator mode so the leader
 * can spawn reviewer sub-agents via the Task tool.
 */
export function createLeaderAgentInit(
	config: LeaderAgentConfig,
	callbacks: LeaderToolCallbacks
): AgentSessionInit {
	const mcpServer = createLeaderMcpServer(config.groupId, callbacks);

	// Build reviewer agents from room config (if any)
	const roomConfig = config.room.config ?? {};
	const reviewerConfigs = roomConfig.reviewers as ReviewerConfig[] | undefined;
	const reviewerAgents =
		reviewerConfigs && reviewerConfigs.length > 0
			? buildReviewerAgents(reviewerConfigs)
			: undefined;
	const hasReviewers = reviewerAgents && Object.keys(reviewerAgents).length > 0;

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
		// Enable coordinator mode when reviewers are configured
		coordinatorMode: hasReviewers ? true : undefined,
		agents: reviewerAgents,
	};
}
