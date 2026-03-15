/**
 * Room Reviewer Sub-Agent Flow (API-dependent)
 *
 * Verifies the autonomous peer review workflow where the Leader agent
 * dispatches reviewer sub-agents via the Task tool before completing a task.
 *
 * Flow tested:
 * 1. Goal created → planning → execution task promoted
 * 2. Coder worker implements the task
 * 3. Leader receives worker output and dispatches reviewer sub-agents
 * 4. Reviewer sub-agents review the code and post reviews to the PR
 * 5. Leader collects review links and routes: forward URLs to worker or submit for review
 * 6. Task reaches terminal state (completed, review, or needs_human)
 *
 * Assertions:
 * - Planning and coding tasks reach terminal state
 * - Group messages contain coder, leader, and system roles
 * - Leader's messages contain Task tool_use blocks dispatching EACH
 *   configured reviewer sub-agent (verified by subagent_type)
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (Sonnet for workers, Sonnet+Haiku for reviewers)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	setupGitEnvironment,
	createRoom,
	createGoal,
	waitForTask,
	waitForTaskCount,
	waitForGroupState,
} from './room-test-helpers';

// Use Sonnet for room agents
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

import { PLANNING_TIMEOUT, CODING_TIMEOUT } from './glm-timeouts';

describe('Room Reviewer Sub-Agent Flow (API-dependent)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;
	// Shared state: first test leaves coding task in 'review', second test approves it
	let codingTaskId: string | null = null;

	beforeAll(async () => {
		daemon = await createDaemonServer();

		// Set up git environment with bare remote and mock gh CLI
		const workspace = process.env.NEOKAI_WORKSPACE_PATH!;
		setupGitEnvironment(workspace);

		// Create a room with a reviewer sub-agent configured
		roomId = await createRoom(daemon, 'Reviewer Flow');

		// Configure the room with multiple reviewer sub-agents (Sonnet + Haiku)
		// This tests that the leader dispatches ALL configured reviewers via Task tool
		await daemon.messageHub.request('room.update', {
			roomId,
			config: {
				agentSubagents: {
					leader: [
						{
							model: 'claude-sonnet-4-5-20250929',
							provider: 'anthropic',
						},
						{
							model: 'claude-haiku-4-5-20251001',
							provider: 'anthropic',
						},
					],
				},
				// Limit review rounds to keep test fast
				maxReviewRounds: 3,
			},
		});

		// Allow event propagation so runtime picks up the updated room config
		// (runtime subscribes to room.updated and refreshes its room reference)
		await Bun.sleep(100);
	}, 30_000);

	afterAll(
		async () => {
			if (savedModel !== undefined) {
				process.env.DEFAULT_MODEL = savedModel;
			} else {
				delete process.env.DEFAULT_MODEL;
			}

			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20_000 }
	);

	test(
		'leader dispatches reviewer sub-agents before completing coding task',
		async () => {
			// --- Create goal ---
			// The goal description explicitly requests a single task to avoid over-planning
			const goal = await createGoal(
				daemon,
				roomId,
				'Add a greet utility',
				'Create a single file src/greet.ts that exports: function greet(name: string): string returning "Hello, <name>!". This is one simple task — no project setup, no tests, no config files. Just the one .ts file.'
			);
			expect(goal.id).toBeTruthy();

			// --- Stage 1: Planning task appears and completes ---
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress'] },
				60_000
			);
			expect(planningTask.taskType).toBe('planning');

			// Planning may end up in 'completed' (leader calls complete_task),
			// 'review' (leader calls submit_for_review for human approval), or 'needs_attention'.
			const terminalPlanning = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['completed', 'review', 'needs_attention'] },
				PLANNING_TIMEOUT
			);

			if (terminalPlanning.status === 'needs_attention') {
				throw new Error(
					`Planning task needs attention: ${(terminalPlanning as { error?: string }).error ?? 'unknown error'}`
				);
			}

			// If planning is in 'review', approve it via task.approve to trigger phase 2
			if (terminalPlanning.status === 'review') {
				await daemon.messageHub.request('task.approve', {
					roomId,
					taskId: terminalPlanning.id,
				});

				// Wait for planning task to complete after phase 2
				await waitForTask(
					daemon,
					roomId,
					{ taskType: 'planning', status: ['completed', 'needs_attention'] },
					PLANNING_TIMEOUT
				);
			}

			// --- Stage 2: Execution tasks promoted ---
			const execTasks = await waitForTaskCount(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['pending', 'in_progress'] },
				1,
				30_000
			);
			expect(execTasks.length).toBeGreaterThanOrEqual(1);

			// --- Stage 3: Coding task reaches terminal state ---
			// With reviewer sub-agents configured, the leader should dispatch
			// reviewers before completing. Task may end up in:
			// - 'completed': leader approved after review
			// - 'review': submit_for_review called (awaiting human)
			// - 'needs_human': escalated (max iterations or other reason)
			// - 'needs_attention': if something goes wrong (less ideal but possible)
			const terminalTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['completed', 'review', 'needs_human', 'needs_attention'] },
				CODING_TIMEOUT
			);

			// Log terminal status for debugging
			console.log(`Coding task reached terminal state: ${terminalTask.status}`);
			if (terminalTask.status === 'needs_attention') {
				console.warn(
					`Coding task needs attention: ${(terminalTask as { error?: string }).error ?? 'unknown error'}`
				);
			}

			// Accept any terminal state — the key assertion is reviewer dispatch evidence below
			expect(['completed', 'review', 'needs_human', 'needs_attention']).toContain(
				terminalTask.status
			);

			// --- Stage 4: Verify group activity ---
			const group = await waitForGroupState(
				daemon,
				roomId,
				terminalTask.id,
				['completed', 'awaiting_human', 'needs_attention'],
				10_000
			);

			// At least one worker → leader round occurred
			expect(group.feedbackIteration).toBeGreaterThanOrEqual(1);

			// --- Stage 5: Verify group messages contain worker, leader, and reviewer dispatch ---
			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: group.id,
			})) as { messages: Array<{ role: string; messageType: string; content: string }> };

			const messageRoles = new Set(messagesResult.messages.map((m) => m.role));
			console.log(
				`Group ${group.id}: ${messagesResult.messages.length} messages, ` +
					`roles: [${[...messageRoles].join(', ')}], ` +
					`feedbackIteration: ${group.feedbackIteration}, ` +
					`group state: ${group.state}`
			);
			expect(messagesResult.messages.length).toBeGreaterThan(0);

			// Worker messages must exist
			expect(messageRoles.has('coder') || messageRoles.has('general')).toBe(true);

			// Leader messages must exist (mirrored from leader session)
			expect(messageRoles.has('leader')).toBe(true);

			// --- Stage 6: Verify leader dispatched BOTH configured reviewer sub-agents ---
			// Parse leader's mirrored messages to find sub-agent dispatch tool_use blocks.
			// The SDK tool name is 'Task' in configuration but may appear as 'Task' or 'Agent'
			// in tool_use blocks depending on SDK version.
			const leaderMessages = messagesResult.messages.filter((m) => m.role === 'leader');
			const dispatchedSubagents = new Set<string>();
			const allToolCalls: Array<{ name: string; subagentType?: string }> = [];

			for (const msg of leaderMessages) {
				try {
					const parsed = JSON.parse(msg.content) as {
						type?: string;
						message?: {
							content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
						};
					};
					if (parsed.type !== 'assistant' || !parsed.message?.content) continue;
					for (const block of parsed.message.content) {
						if (block.type !== 'tool_use' || !block.name) continue;
						const subagentType = block.input?.subagent_type as string | undefined;
						allToolCalls.push({ name: block.name, subagentType });
						// Match Task or Agent tool with subagent_type referencing a reviewer
						if ((block.name === 'Task' || block.name === 'Agent') && subagentType) {
							dispatchedSubagents.add(subagentType);
						}
					}
				} catch {
					// Skip non-JSON messages (status messages, etc.)
				}
			}

			console.log(`Leader tool calls: ${JSON.stringify(allToolCalls)}`);
			console.log(`Dispatched sub-agents: [${[...dispatchedSubagents].join(', ')}]`);

			// Both configured reviewers must have been dispatched via Task tool
			// Reviewer names use short model names: reviewer-sonnet, reviewer-haiku
			expect(dispatchedSubagents.has('reviewer-sonnet')).toBe(true);
			expect(dispatchedSubagents.has('reviewer-haiku')).toBe(true);

			// --- Capture coding task ID for follow-up approve test ---
			if (terminalTask.status === 'review') {
				codingTaskId = terminalTask.id;
			}
		},
		{ timeout: 600_000 }
	);

	test(
		'approve coding task routes to worker for PR merge, then completes',
		async () => {
			if (!codingTaskId) {
				console.log('Skipping: coding task did not reach review state in previous test');
				return;
			}

			// --- Approve the coding task ---
			// This should route to the WORKER (not leader) with approved=true
			// Worker merges the PR via `gh pr merge`, then exits
			// Leader receives terminal state and calls complete_task (bypasses submittedForReview gate)
			const result = await daemon.messageHub.request('task.approve', {
				roomId,
				taskId: codingTaskId,
			});
			expect(result).toEqual({ success: true });

			console.log(`Approved coding task ${codingTaskId}, waiting for completion...`);

			// --- Wait for task to complete ---
			// After worker merges and exits, leader should complete the task
			const completedTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['completed', 'needs_attention'] },
				180_000
			);

			console.log(`Coding task final status: ${completedTask.status}`);
			expect(completedTask.status).toBe('completed');

			// --- Verify group reached completed state ---
			const group = await waitForGroupState(
				daemon,
				roomId,
				codingTaskId,
				['completed', 'needs_attention'],
				10_000
			);
			expect(group.state).toBe('completed');

			// --- Verify worker received the merge instruction ---
			// Use high limit — the approval message may be beyond the default 100
			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: group.id,
				limit: 500,
			})) as { messages: Array<{ role: string; messageType: string; content: string }> };

			// There should be a human message with the merge instruction
			const humanMessages = messagesResult.messages.filter((m) => m.role === 'human');
			const hasMergeInstruction = humanMessages.some((m) => m.content.includes('gh pr merge'));
			expect(hasMergeInstruction).toBe(true);

			console.log(`Approve→merge→complete flow verified for task ${codingTaskId}`);
		},
		{ timeout: 300_000 }
	);
});
