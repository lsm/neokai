/**
 * Room Chat Agent Tools (API-dependent)
 *
 * Verifies that the room chat agent can use MCP tools to create goals
 * and that the runtime picks them up for planning/execution.
 *
 * Flow: send message to room chat → agent calls create_goal MCP tool →
 *       goal appears in goal.list → runtime starts planning.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import type { RoomGoal } from '@neokai/shared';
import { waitForTask, createRoom } from './room-test-helpers';

// Use Sonnet for room agents
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

describe('Room Chat Agent Tools (API-dependent)', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
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
		'room chat agent creates goal via MCP tool and runtime starts planning',
		async () => {
			const roomId = await createRoom(daemon, 'Chat Agent Tools');
			const roomChatSessionId = `room:chat:${roomId}`;
			daemon.trackSession(roomChatSessionId);

			// --- Send message asking the agent to create a goal ---
			await sendMessage(
				daemon,
				roomChatSessionId,
				'Create a goal to add a negate utility function. The function should be in src/negate.ts and export negate(n: number): number which returns -n. Do not do anything else, just create the goal.'
			);
			await waitForIdle(daemon, roomChatSessionId, 120_000);

			// --- Verify a goal was created ---
			const goalsResult = (await daemon.messageHub.request('goal.list', {
				roomId,
			})) as { goals: RoomGoal[] };

			expect(goalsResult.goals.length).toBeGreaterThanOrEqual(1);
			const goal = goalsResult.goals[0];
			expect(goal.status).toBe('active');

			// --- Verify the runtime picked it up: planning task appears ---
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress', 'completed'] },
				120_000
			);
			expect(planningTask.taskType).toBe('planning');
		},
		{ timeout: 300_000 }
	);
});
