/**
 * Room Multi-Agent Flow (API-dependent)
 *
 * Verifies the end-to-end room lifecycle through a single goal that
 * progresses through all stages: planning → task promotion → execution → completion.
 *
 * Uses a shared daemon. Assertions at each checkpoint pinpoint exactly
 * which stage broke.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (mock mode not supported for multi-agent flow)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { RoomGoal } from '@neokai/shared';
import {
	setupGitEnvironment,
	waitForTask,
	waitForTaskCount,
	waitForGroupState,
} from './room-test-helpers';

// Use Sonnet for room agents (default model may be GLM in CI)
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

describe('Room Multi-Agent Flow (API-dependent)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;

	beforeAll(async () => {
		daemon = await createDaemonServer();

		// Set up git environment with bare remote and mock gh CLI
		setupGitEnvironment(process.env.NEOKAI_WORKSPACE_PATH!);

		const result = (await daemon.messageHub.request('room.create', {
			name: `Multi-Agent Flow ${Date.now()}`,
		})) as { room: { id: string } };
		roomId = result.room.id;
	}, 30_000);

	afterAll(
		async () => {
			// Restore model
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
		'goal → planning → execution → completion lifecycle',
		async () => {
			// --- Create goal ---
			const goalResult = (await daemon.messageHub.request('goal.create', {
				roomId,
				title: 'Add a capitalize utility',
				description:
					'Create a single file src/capitalize.ts that exports function capitalize(s: string): string. ' +
					'This is one trivial task — just the one file, no tests, no config, no setup.',
			})) as { goal: RoomGoal };

			const goalId = goalResult.goal.id;
			expect(goalId).toBeTruthy();

			// --- Stage 1: Planning task appears ---
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress'] },
				60_000
			);
			expect(planningTask.taskType).toBe('planning');
			expect(planningTask.title).toContain('Plan:');

			const goalAfterPlanning = (
				(await daemon.messageHub.request('goal.get', { roomId, goalId })) as {
					goal: RoomGoal;
				}
			).goal;
			expect(goalAfterPlanning.planning_attempts).toBeGreaterThanOrEqual(1);

			const planningGroup = await waitForGroupState(
				daemon,
				roomId,
				planningTask.id,
				['awaiting_worker', 'awaiting_leader', 'completed', 'failed'],
				30_000
			);
			expect(planningGroup.id).toBeTruthy();

			// --- Stage 2: Planning completes, execution tasks promoted ---
			// Two-phase planner: plan → review → human approve → worker creates tasks → complete
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
			// If planning is in 'review', approve via task.approve to trigger phase 2
			// (worker resumes with approved=true, creates draft tasks, leader completes)
			if (terminalPlanning.status === 'review') {
				await daemon.messageHub.request('task.approve', {
					roomId,
					taskId: terminalPlanning.id,
				});
			}

			// Wait for planning to fully complete (phase 2 may take time for task creation)
			await waitForTask(daemon, roomId, { taskType: 'planning', status: ['completed'] }, 120_000);

			const execTasks = await waitForTaskCount(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['pending', 'in_progress'] },
				1,
				30_000
			);
			expect(execTasks.length).toBeGreaterThanOrEqual(1);

			const goalAfterExecPromotion = (
				(await daemon.messageHub.request('goal.get', { roomId, goalId })) as {
					goal: RoomGoal;
				}
			).goal;
			expect((goalAfterExecPromotion.linkedTaskIds ?? []).length).toBeGreaterThanOrEqual(2);

			// --- Stage 3: Execution completes through worker → leader cycle ---
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
			// If coding is in 'review', approve via task.approve to trigger PR merge
			if (terminalCoding.status === 'review') {
				await daemon.messageHub.request('task.approve', {
					roomId,
					taskId: terminalCoding.id,
				});
			}
			const completedTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['completed'] },
				120_000
			);
			expect(completedTask.status).toBe('completed');
			expect(completedTask.result).toBeTruthy();
			expect(completedTask.result!.length).toBeGreaterThan(10);

			const execGroup = await waitForGroupState(
				daemon,
				roomId,
				completedTask.id,
				['completed'],
				10_000
			);
			expect(execGroup.state).toBe('completed');

			// Verify group messages exist (the mirrored worker↔leader timeline)
			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: execGroup.id,
			})) as { messages: unknown[]; hasMore: boolean };
			expect(messagesResult.messages.length).toBeGreaterThan(0);

			// Verify feedback iteration tracking (at least 1 worker→leader round)
			expect(execGroup.feedbackIteration).toBeGreaterThanOrEqual(1);
		},
		{ timeout: 300_000 }
	);
});
