/**
 * Room Advanced Scenarios (API-dependent)
 *
 * Tests goal pause/resume and group message quality in a single
 * progressive test to avoid redundant API calls:
 *
 *   goal → planning → coding task appears → pause (needs_human) →
 *   verify status → reactivate → execution completes →
 *   verify messages + feedback iteration
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	setupGitEnvironment,
	waitForTask,
	waitForGroupState,
	createRoom,
	createGoal,
	getGoal,
} from './room-test-helpers';

// Use Sonnet for room agents (default model may be GLM in CI)
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

describe('Room Advanced Scenarios (API-dependent)', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();

		// Set up git environment with bare remote and mock gh CLI
		setupGitEnvironment(process.env.NEOKAI_WORKSPACE_PATH!);
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
		'goal pause/resume + group message verification',
		async () => {
			const roomId = await createRoom(daemon, 'Advanced Scenarios');

			// --- Stage 1: Create goal and let planning complete ---
			const goal = await createGoal(
				daemon,
				roomId,
				'Add a triple utility',
				'Create src/triple.ts that exports triple(n: number): number which returns n * 3.'
			);

			const terminalPlanning = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['completed', 'review', 'failed'] },
				120_000
			);
			if (terminalPlanning.status === 'failed') {
				throw new Error(
					`Planning task failed: ${(terminalPlanning as { error?: string }).error ?? 'unknown error'}`
				);
			}
			// If planning is in 'review', approve via goal.approveTask to trigger phase 2
			// (worker resumes with approved=true, creates draft tasks, leader completes)
			if (terminalPlanning.status === 'review') {
				await daemon.messageHub.request('goal.approveTask', {
					roomId,
					taskId: terminalPlanning.id,
				});
			}

			// Wait for planning to fully complete (phase 2 may take time)
			await waitForTask(daemon, roomId, { taskType: 'planning', status: ['completed'] }, 120_000);

			// Wait for coding task to appear
			await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['pending', 'in_progress'] },
				60_000
			);

			// --- Stage 2: Pause goal via needs_human ---
			await daemon.messageHub.request('goal.needsHuman', { roomId, goalId: goal.id });

			const pausedGoal = await getGoal(daemon, roomId, goal.id);
			expect(pausedGoal.status).toBe('needs_human');

			// --- Stage 3: Reactivate and verify execution resumes ---
			await daemon.messageHub.request('goal.reactivate', { roomId, goalId: goal.id });

			const reactivatedGoal = await getGoal(daemon, roomId, goal.id);
			expect(reactivatedGoal.status).toBe('active');

			// Wait for coding task to reach terminal state (already-running group finishes
			// or new group spawns after reactivation)
			// Two-phase coder: code → review → human approve → worker merges PR → complete
			const terminalCoding = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['completed', 'review', 'failed'] },
				120_000
			);
			if (terminalCoding.status === 'failed') {
				throw new Error(
					`Coding task failed: ${(terminalCoding as { error?: string }).error ?? 'unknown error'}`
				);
			}
			if (terminalCoding.status === 'review') {
				await daemon.messageHub.request('goal.approveTask', {
					roomId,
					taskId: terminalCoding.id,
				});
			}
			const completedTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: 'completed' },
				120_000
			);
			expect(completedTask.status).toBe('completed');
			expect(completedTask.result).toBeTruthy();
			expect(completedTask.result!.length).toBeGreaterThan(10);

			// --- Stage 4: Verify group messages ---
			const execGroup = await waitForGroupState(
				daemon,
				roomId,
				completedTask.id,
				['completed'],
				10_000
			);
			expect(execGroup.feedbackIteration).toBeGreaterThanOrEqual(1);

			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: execGroup.id,
			})) as {
				messages: Array<{
					id: number;
					role: string;
					messageType: string;
					content: string;
					sessionId: string | null;
				}>;
				hasMore: boolean;
			};

			const messages = messagesResult.messages;
			expect(messages.length).toBeGreaterThan(0);

			// Verify messages have expected structure
			for (const msg of messages) {
				expect(msg.role).toBeTruthy();
				expect(msg.messageType).toBeTruthy();
				expect(msg.content).toBeTruthy();
				expect(msg.content.length).toBeGreaterThan(0);
			}

			// Verify messages from at least one role
			const roles = new Set(messages.map((m) => m.role));
			expect(roles.size).toBeGreaterThanOrEqual(1);
		},
		{ timeout: 300_000 }
	);
});
