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
 * 4. Reviewer sub-agents review the code and return verdicts
 * 5. Leader consolidates verdicts and decides: complete or send back
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

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	createRoom,
	createGoal,
	waitForTask,
	waitForTaskCount,
	waitForGroupState,
} from './room-test-helpers';

// Use Sonnet for room agents
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

/**
 * Create a bare git remote + stateful mock `gh` CLI in the workspace.
 *
 * This is needed because:
 * - The coder worker creates feature branches and pushes code
 * - The Leader's system prompt requires PRs for the reviewer workflow
 * - Without a remote and `gh`, the agent can't create PRs and will fail_task
 *
 * The mock `gh` is STATEFUL to enforce reviewer dispatch:
 * - `gh pr view ... reviews` initially returns 0 reviews
 * - `gh api` calls (review POSTs) create a flag file
 * - After flag is set, `gh pr view ... reviews` returns 1
 *
 * This forces the lifecycle hooks to reject `submit_for_review` until
 * actual reviewer sub-agents have "posted" reviews via `gh api`.
 */
function setupGitEnvironment(workspace: string): void {
	// 1. Init as git repo with a proper initial commit
	execSync('git init && git commit --allow-empty -m "init"', {
		cwd: workspace,
		stdio: 'pipe',
	});

	// 2. Create a bare remote repo so `git push` works
	const bareRemote = path.join(workspace, '..', `bare-remote-${Date.now()}`);
	mkdirSync(bareRemote, { recursive: true });
	execSync('git init --bare', { cwd: bareRemote, stdio: 'pipe' });
	execSync(`git remote add origin "${bareRemote}"`, {
		cwd: workspace,
		stdio: 'pipe',
	});
	// Push initial commit so remote has a default branch
	execSync('git push -u origin HEAD', {
		cwd: workspace,
		stdio: 'pipe',
	});

	// 3. Create state directory for mock gh
	const stateDir = path.join(workspace, '.mock-state');
	mkdirSync(stateDir, { recursive: true });

	// 4. Create mock `gh` script
	const mockBin = path.join(workspace, '.mock-bin');
	mkdirSync(mockBin, { recursive: true });

	// The mock is stateful: `gh api` POST creates a flag file,
	// and `gh pr view ... reviews` checks for it.
	// This forces the Leader to dispatch reviewers before submit_for_review.
	const ghScript = `#!/bin/bash
# Stateful mock gh CLI for testing reviewer flow
STATE_DIR="${stateDir}"

case "$1" in
  pr)
    case "$2" in
      create)
        echo "https://github.com/test/repo/pull/1"
        exit 0
        ;;
      list)
        echo '[{"number":1,"url":"https://github.com/test/repo/pull/1","headRefName":"test-branch"}]'
        exit 0
        ;;
      view)
        if echo "$*" | grep -q "headRefOid"; then
          # Return HEAD SHA from current directory (the worktree)
          git rev-parse HEAD 2>/dev/null || echo "abc1234"
          exit 0
        elif echo "$*" | grep -q "reviews"; then
          # Stateful: check if reviews have been "posted" via gh api
          if [ -f "$STATE_DIR/.reviews-posted" ]; then
            echo '1'
          else
            echo '0'
          fi
          exit 0
        else
          echo '{"number":1,"url":"https://github.com/test/repo/pull/1","state":"OPEN"}'
          exit 0
        fi
        ;;
      review)
        # gh pr review --approve/--comment/--request-changes
        # This is the ONLY way to post a proper PR review that the lifecycle hook detects.
        touch "$STATE_DIR/.reviews-posted"
        echo '{"state":"APPROVED"}'
        exit 0
        ;;
      comment)
        # gh pr comment - creates a PR comment (NOT a review)
        echo "https://github.com/test/repo/pull/1#issuecomment-1"
        exit 0
        ;;
      merge)
        # gh pr merge — used by worker to merge approved PR
        echo "Pull request #1 merged"
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  api)
    # Generic gh api call - does NOT set reviews-posted flag.
    # Only gh pr review creates proper PR reviews that the lifecycle hook detects.
    echo '{"id":1}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	writeFileSync(path.join(mockBin, 'gh'), ghScript);
	chmodSync(path.join(mockBin, 'gh'), 0o755);

	// 5. Prepend mock bin to PATH so agents find mock `gh` first
	process.env.PATH = `${mockBin}:${process.env.PATH}`;
}

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
			// 'review' (leader calls submit_for_review for human approval), or 'failed'.
			const terminalPlanning = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['completed', 'review', 'failed'] },
				180_000
			);

			if (terminalPlanning.status === 'failed') {
				throw new Error(
					`Planning task failed: ${(terminalPlanning as { error?: string }).error ?? 'unknown error'}`
				);
			}

			// If planning is in 'review', approve it via goal.approveTask to trigger phase 2
			// (task.approve bypasses the runtime and skips phase 2 where tasks are created)
			if (terminalPlanning.status === 'review') {
				await daemon.messageHub.request('goal.approveTask', {
					roomId,
					taskId: terminalPlanning.id,
				});

				// Wait for planning task to complete after phase 2
				await waitForTask(
					daemon,
					roomId,
					{ taskType: 'planning', status: ['completed', 'failed'] },
					180_000
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
			// - 'failed': if something goes wrong (less ideal but possible)
			const terminalTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['completed', 'review', 'needs_human', 'failed'] },
				420_000
			);

			// Log terminal status for debugging
			console.log(`Coding task reached terminal state: ${terminalTask.status}`);
			if (terminalTask.status === 'failed') {
				console.warn(
					`Coding task failed: ${(terminalTask as { error?: string }).error ?? 'unknown error'}`
				);
			}

			// Accept any terminal state — the key assertion is reviewer dispatch evidence below
			expect(['completed', 'review', 'needs_human', 'failed']).toContain(terminalTask.status);

			// --- Stage 4: Verify group activity ---
			const group = await waitForGroupState(
				daemon,
				roomId,
				terminalTask.id,
				['completed', 'awaiting_human', 'failed'],
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
			const result = await daemon.messageHub.request('goal.approveTask', {
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
				{ taskType: 'coding', status: ['completed', 'failed'] },
				180_000
			);

			console.log(`Coding task final status: ${completedTask.status}`);
			expect(completedTask.status).toBe('completed');

			// --- Verify group reached completed state ---
			const group = await waitForGroupState(
				daemon,
				roomId,
				codingTaskId,
				['completed', 'failed'],
				10_000
			);
			expect(group.state).toBe('completed');

			// --- Verify worker received the merge instruction ---
			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: group.id,
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
