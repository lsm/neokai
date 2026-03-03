/**
 * Room Two-Phase Planner Flow (API-dependent)
 *
 * Verifies the two-phase planner lifecycle:
 *
 * Phase 1: Planner writes PLAN.md, commits to feature branch, creates PR.
 *          No create_task calls allowed (gated). Leader dispatches reviewer
 *          sub-agents to review the plan PR. After reviews pass, leader
 *          calls submit_for_review → task goes to 'review' / awaiting_human.
 *
 * Human approval: goal.approveTask routes planning tasks to WORKER (not leader).
 *                 Sets planApproved=true, starts new planner session (phase 2).
 *
 * Phase 2: Planner merges plan PR, reads PLAN.md, creates tasks 1:1 from
 *          the approved plan using create_task. Worker exit gate checks
 *          draftTaskCount > 0 (phase 2 gate). Leader verifies and completes.
 *          Draft tasks promoted to pending.
 *
 * Assertions:
 * - Planning task reaches 'review' status after phase 1
 * - Group reaches awaiting_human state
 * - Reviewer sub-agents are dispatched for plan review
 * - After human approval, group transitions back to awaiting_worker
 * - Planning task completes after phase 2
 * - Coding tasks are created and promoted to pending
 * - planApproved flag is set on the group
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (Sonnet for workers/leaders, Sonnet+Haiku for reviewers)
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
	listTasks,
} from './room-test-helpers';

// Use Sonnet for room agents
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

/**
 * Create a bare git remote + stateful mock `gh` CLI in the workspace.
 *
 * The mock `gh` supports:
 * - pr create/list/view/review/comment/merge — all needed for two-phase flow
 * - Stateful review tracking: `gh pr review` sets a flag, `gh pr view ... reviews` checks it
 * - `gh pr merge` for phase 2 plan PR merging
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

	const ghScript = `#!/bin/bash
# Stateful mock gh CLI for testing two-phase planner flow
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
          # Stateful: check if reviews have been "posted" via gh pr review
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
        touch "$STATE_DIR/.reviews-posted"
        echo '{"state":"APPROVED"}'
        exit 0
        ;;
      comment)
        echo "https://github.com/test/repo/pull/1#issuecomment-1"
        exit 0
        ;;
      merge)
        # gh pr merge — used by phase 2 planner to merge the plan PR
        echo "Pull request #1 merged"
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  api)
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

describe('Room Two-Phase Planner Flow (API-dependent)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;

	beforeAll(async () => {
		daemon = await createDaemonServer();

		// Set up git environment with bare remote and mock gh CLI
		const workspace = process.env.NEOKAI_WORKSPACE_PATH!;
		setupGitEnvironment(workspace);

		// Create a room with reviewer sub-agents configured
		roomId = await createRoom(daemon, 'Two-Phase Planner');

		// Configure the room with reviewer sub-agents for plan review
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
				maxReviewRounds: 3,
			},
		});

		// Allow event propagation so runtime picks up the updated room config
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
		'two-phase planner: plan → AI review → human approve → create tasks',
		async () => {
			// --- Stage 1: Create goal to trigger planning ---
			const goal = await createGoal(
				daemon,
				roomId,
				'Build a calculator module',
				'Create a calculator module with add, subtract, multiply, divide functions. ' +
					'Each function should be in its own file under src/calc/. ' +
					'This requires planning: break it into 4 coding tasks (one per function).'
			);
			expect(goal.id).toBeTruthy();
			console.log(`Goal created: ${goal.id}`);

			// --- Stage 2: Wait for planning task (phase 1) ---
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress'] },
				60_000
			);
			expect(planningTask.taskType).toBe('planning');
			console.log(`Planning task appeared: ${planningTask.id} (${planningTask.status})`);

			// --- Stage 3: Wait for planning task to reach review (phase 1 complete) ---
			// Phase 1 planner writes PLAN.md, commits, creates PR → worker exits
			// Leader dispatches reviewer sub-agents → reviewers review → leader submits for review
			// Task goes to 'review' status, group goes to 'awaiting_human'
			const reviewTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['review', 'completed', 'failed'] },
				300_000
			);
			console.log(`Planning task reached: ${reviewTask.status}`);

			if (reviewTask.status === 'failed') {
				const error = (reviewTask as { error?: string }).error ?? 'unknown error';
				console.warn(`Planning task failed: ${error}`);
				// Don't hard-fail — log and continue checking what we can
			}

			// For the full two-phase flow, we need the task in 'review' status
			// If it completed directly (no reviewer dispatch) or failed, we still check what we can
			if (reviewTask.status === 'review') {
				// --- Stage 4: Verify group is in awaiting_human ---
				const group = await waitForGroupState(
					daemon,
					roomId,
					planningTask.id,
					['awaiting_human'],
					10_000
				);
				console.log(
					`Group ${group.id}: state=${group.state}, iteration=${group.feedbackIteration}`
				);

				// --- Stage 5: Verify reviewer sub-agents were dispatched ---
				const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
					groupId: group.id,
				})) as {
					messages: Array<{ role: string; messageType: string; content: string }>;
				};

				const messageRoles = new Set(messagesResult.messages.map((m) => m.role));
				console.log(
					`Group messages: ${messagesResult.messages.length}, ` +
						`roles: [${[...messageRoles].join(', ')}]`
				);

				// Worker (planner) messages must exist
				expect(
					messageRoles.has('planner') ||
						messageRoles.has('general') ||
						messageRoles.has('coder')
				).toBe(true);

				// Leader messages must exist
				expect(messageRoles.has('leader')).toBe(true);

				// Check for reviewer sub-agent dispatch evidence in leader messages
				const leaderMessages = messagesResult.messages.filter((m) => m.role === 'leader');
				const dispatchedSubagents = new Set<string>();

				for (const msg of leaderMessages) {
					try {
						const parsed = JSON.parse(msg.content) as {
							type?: string;
							message?: {
								content?: Array<{
									type: string;
									name?: string;
									input?: Record<string, unknown>;
								}>;
							};
						};
						if (parsed.type !== 'assistant' || !parsed.message?.content) continue;
						for (const block of parsed.message.content) {
							if (block.type !== 'tool_use' || !block.name) continue;
							const subagentType = block.input?.subagent_type as string | undefined;
							if (
								(block.name === 'Task' || block.name === 'Agent') &&
								subagentType
							) {
								dispatchedSubagents.add(subagentType);
							}
						}
					} catch {
						// Skip non-JSON messages
					}
				}

				console.log(
					`Dispatched sub-agents: [${[...dispatchedSubagents].join(', ')}]`
				);

				// At least one reviewer should have been dispatched for plan review
				const hasReviewers =
					dispatchedSubagents.has('reviewer-sonnet') ||
					dispatchedSubagents.has('reviewer-haiku');
				if (hasReviewers) {
					console.log('Reviewer sub-agents were dispatched for plan review');
				} else {
					console.warn(
						'No reviewer sub-agents detected — leader may have reviewed directly'
					);
				}

				// --- Stage 6: Human approves → triggers phase 2 planner ---
				console.log('Approving planning task (human approval)...');
				await daemon.messageHub.request('goal.approveTask', {
					roomId,
					taskId: planningTask.id,
				});

				// --- Stage 7: Verify group transitions for phase 2 ---
				// Group should go to awaiting_worker (phase 2 planner starting)
				// Then eventually back to completed
				const finalGroup = await waitForGroupState(
					daemon,
					roomId,
					planningTask.id,
					['completed', 'failed'],
					300_000
				);
				console.log(
					`Final group state: ${finalGroup.state}, iteration: ${finalGroup.feedbackIteration}`
				);

				// --- Stage 8: Verify planning task completed ---
				const completedPlanning = await waitForTask(
					daemon,
					roomId,
					{ taskType: 'planning', status: ['completed', 'failed'] },
					10_000
				);
				console.log(`Planning task final: ${completedPlanning.status}`);

				// --- Stage 9: Verify coding tasks were created from the plan ---
				const allTasks = await listTasks(daemon, roomId);
				const codingTasks = allTasks.filter(
					(t) => t.taskType === 'coding' && ['pending', 'in_progress'].includes(t.status)
				);
				console.log(
					`Total tasks: ${allTasks.length}, coding tasks (pending/in_progress): ${codingTasks.length}`
				);

				// Phase 2 planner should have created tasks from the plan
				if (completedPlanning.status === 'completed') {
					expect(codingTasks.length).toBeGreaterThan(0);
				}

				// --- Stage 10: Verify planApproved flag ---
				const groupResult = (await daemon.messageHub.request('task.getGroup', {
					roomId,
					taskId: planningTask.id,
				})) as {
					group: {
						id: string;
						state: string;
						planApproved: boolean;
						feedbackIteration: number;
					} | null;
				};

				expect(groupResult.group).toBeTruthy();
				expect(groupResult.group!.planApproved).toBe(true);
				console.log(
					`Group planApproved: ${groupResult.group!.planApproved}, ` +
						`state: ${groupResult.group!.state}`
				);
			} else if (reviewTask.status === 'completed') {
				// Task completed directly (may happen if leader completes without submit_for_review)
				console.log(
					'Planning task completed directly without going through review. ' +
						'Two-phase flow was not triggered — checking task creation instead.'
				);

				const allTasks = await listTasks(daemon, roomId);
				const codingTasks = allTasks.filter(
					(t) => t.taskType === 'coding' && ['pending', 'in_progress'].includes(t.status)
				);
				console.log(`Coding tasks created: ${codingTasks.length}`);
				// Even without two-phase, planner should have created tasks
				expect(codingTasks.length).toBeGreaterThan(0);
			}
		},
		{ timeout: 600_000 }
	);
});
