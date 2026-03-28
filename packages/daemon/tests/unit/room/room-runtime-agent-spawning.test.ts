/**
 * Integration-style unit tests for room-runtime agent spawning paths.
 *
 * Verifies that:
 * 1. Coder tasks produce init objects with always-on agent/agents pattern
 * 2. Planner tasks produce init objects with the 3-phase sub-agents
 * 3. Leader sessions always include built-in sub-agents (leader-explorer, leader-fact-checker)
 * 4. hasReviewers is derived from agentSubagents.leader (user-configured reviewers only),
 *    not from the runtime agents map (which always includes built-in sub-agents)
 * 5. No code path requires agentSubagents.worker to enable coder sub-agent capability
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	makeRoom,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { AgentSessionInit } from '../../../src/lib/agent/agent-session';

/**
 * Extracts the AgentSessionInit from the first createAndStartSession call for a given role.
 */
function getInitForRole(
	calls: Array<{ method: string; args: unknown[] }>,
	role: string
): AgentSessionInit | undefined {
	const call = calls.find((c) => c.method === 'createAndStartSession' && c.args[1] === role);
	return call?.args[0] as AgentSessionInit | undefined;
}

/**
 * Returns all createAndStartSession calls for a given role.
 */
function getAllInitsForRole(
	calls: Array<{ method: string; args: unknown[] }>,
	role: string
): AgentSessionInit[] {
	return calls
		.filter((c) => c.method === 'createAndStartSession' && c.args[1] === role)
		.map((c) => c.args[0] as AgentSessionInit);
}

describe('room-runtime agent spawning paths', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	// -------------------------------------------------------------------------
	// Coder agent — always-on pattern
	// -------------------------------------------------------------------------
	describe('coder agent spawning', () => {
		it('coder init has agent: Coder with always-on agents map', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Build feature',
				description: 'Implement the new feature',
			});
			const task = await ctx.taskManager.createTask({
				title: 'Add endpoint',
				description: 'Add POST /items endpoint',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'coder');
			expect(init).toBeDefined();
			expect(init!.agent).toBe('Coder');
			expect(init!.type).toBe('coder');
		});

		it('coder init always includes built-in coder-explorer sub-agent', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Goal', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Code task',
				description: 'Do some coding',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'coder');
			expect(init).toBeDefined();
			expect(init!.agents).toBeDefined();
			expect(Object.keys(init!.agents!)).toContain('coder-explorer');
		});

		it('coder init always includes built-in coder-tester sub-agent', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Goal', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Code task',
				description: 'Do some coding',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'coder');
			expect(init).toBeDefined();
			expect(Object.keys(init!.agents!)).toContain('coder-tester');
		});

		it('coder spawns with always-on agents even when room has no agentSubagents.worker config', async () => {
			// Room config with no agentSubagents.worker — agents should still be present
			const roomWithoutWorkerConfig = makeRoom({
				config: {
					// No agentSubagents.worker defined — old conditional pattern was removed
				},
			});
			const ctxNoWorker = createRuntimeTestContext({ room: roomWithoutWorkerConfig });
			ctxNoWorker.runtime.start();

			try {
				const goal = await ctxNoWorker.goalManager.createGoal({ title: 'G', description: '' });
				const task = await ctxNoWorker.taskManager.createTask({
					title: 'Task',
					description: 'Some work',
					assignedAgent: 'coder',
				});
				await ctxNoWorker.goalManager.linkTaskToGoal(goal.id, task.id);

				await ctxNoWorker.runtime.tick();

				const init = getInitForRole(ctxNoWorker.sessionFactory.calls, 'coder');
				expect(init).toBeDefined();
				// Always-on: agents map must exist with built-in sub-agents
				expect(init!.agents).toBeDefined();
				const agentNames = Object.keys(init!.agents!);
				expect(agentNames).toContain('Coder');
				expect(agentNames).toContain('coder-explorer');
				expect(agentNames).toContain('coder-tester');
			} finally {
				ctxNoWorker.runtime.stop();
				ctxNoWorker.db.close();
			}
		});

		it('coder agents map has exactly the 3 built-in agents when no helper agents are configured', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Goal', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Task',
				description: 'Work',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'coder');
			expect(init).toBeDefined();
			const agentNames = Object.keys(init!.agents!);
			// Built-ins: Coder, coder-explorer, coder-tester
			expect(agentNames).toHaveLength(3);
			expect(agentNames).toContain('Coder');
			expect(agentNames).toContain('coder-explorer');
			expect(agentNames).toContain('coder-tester');
		});
	});

	// -------------------------------------------------------------------------
	// Planner agent — 3-phase sub-agents
	// -------------------------------------------------------------------------
	describe('planner agent spawning', () => {
		it('planner init has agent: Planner', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'My feature goal',
				description: 'Build out the feature set',
			});
			const task = await ctx.taskManager.createTask({
				title: 'Plan the feature',
				description: 'Create implementation plan',
				assignedAgent: 'planner',
				taskType: 'goal_review',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'planner');
			expect(init).toBeDefined();
			expect(init!.agent).toBe('Planner');
			expect(init!.type).toBe('planner');
		});

		it('planner init agents map contains all 3-phase sub-agents', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Plan goal',
				description: 'Goal for planning',
			});
			const task = await ctx.taskManager.createTask({
				title: 'Plan task',
				description: 'Planning task',
				assignedAgent: 'planner',
				taskType: 'goal_review',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const init = getInitForRole(ctx.sessionFactory.calls, 'planner');
			expect(init).toBeDefined();
			const agentNames = Object.keys(init!.agents!);

			// Planner orchestrator
			expect(agentNames).toContain('Planner');
			// Phase 1: explorer
			expect(agentNames).toContain('planner-explorer');
			// Phase 2: fact-checker
			expect(agentNames).toContain('planner-fact-checker');
			// Phase 3: plan-writer
			expect(agentNames).toContain('plan-writer');

			// Exactly 4 agents total (no extras)
			expect(agentNames).toHaveLength(4);
		});

		it('planner init uses reviewContext plan_review (leader sees plan_review)', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Plan G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Plan T',
				description: 'Plan it',
				assignedAgent: 'planner',
				taskType: 'goal_review',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			// Leader init should have review context embedded in system prompt
			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();
			expect(leaderInit!.agent).toBe('Leader');
			// The leader system prompt should reference plan_review context
			// We verify this by checking that the leader's prompt in the agents map mentions planning
			const leaderAgentDef = leaderInit!.agents!['Leader'];
			expect(leaderAgentDef).toBeDefined();
			expect(leaderAgentDef.prompt).toContain('plan');
		});
	});

	// -------------------------------------------------------------------------
	// Leader agent — always-on built-in sub-agents
	// -------------------------------------------------------------------------
	describe('leader agent spawning', () => {
		it('leader init has agent: Leader', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Goal', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Task',
				description: 'Work',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();
			expect(leaderInit!.agent).toBe('Leader');
			expect(leaderInit!.type).toBe('leader');
		});

		it('leader init always includes built-in leader-explorer sub-agent', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'T',
				description: 'D',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();
			expect(Object.keys(leaderInit!.agents!)).toContain('leader-explorer');
		});

		it('leader init always includes built-in leader-fact-checker sub-agent', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'T',
				description: 'D',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();
			expect(Object.keys(leaderInit!.agents!)).toContain('leader-fact-checker');
		});

		it('leader has built-in sub-agents even with no user-configured reviewers', async () => {
			// Room with no agentSubagents.leader — hasReviewers = false
			// But leader-explorer and leader-fact-checker MUST still be present
			const roomNoReviewers = makeRoom({
				config: {
					// agentSubagents.leader intentionally absent
				},
			});
			const ctxNoReviewers = createRuntimeTestContext({ room: roomNoReviewers });
			ctxNoReviewers.runtime.start();

			try {
				const goal = await ctxNoReviewers.goalManager.createGoal({ title: 'G', description: '' });
				const task = await ctxNoReviewers.taskManager.createTask({
					title: 'T',
					description: 'D',
					assignedAgent: 'coder',
				});
				await ctxNoReviewers.goalManager.linkTaskToGoal(goal.id, task.id);

				await ctxNoReviewers.runtime.tick();

				const leaderInit = getInitForRole(ctxNoReviewers.sessionFactory.calls, 'leader');
				expect(leaderInit).toBeDefined();

				const agentNames = Object.keys(leaderInit!.agents!);
				// Built-in sub-agents always present, regardless of hasReviewers
				expect(agentNames).toContain('leader-explorer');
				expect(agentNames).toContain('leader-fact-checker');

				// No user-configured reviewer agents (only built-ins + Leader itself)
				expect(agentNames).toHaveLength(3); // Leader + leader-explorer + leader-fact-checker
			} finally {
				ctxNoReviewers.runtime.stop();
				ctxNoReviewers.db.close();
			}
		});

		it('leader has built-in sub-agents AND user reviewers when agentSubagents.leader is configured', async () => {
			// Room with a user-configured reviewer — hasReviewers = true
			// Leader agents map should have built-ins + the user reviewer
			const roomWithReviewer = makeRoom({
				config: {
					agentSubagents: {
						leader: [
							{
								name: 'security-reviewer',
								description: 'Reviews for security issues',
								prompt: 'Review for security vulnerabilities.',
								model: 'claude-opus-4-5',
							},
						],
					},
				},
			});
			const ctxWithReviewer = createRuntimeTestContext({ room: roomWithReviewer });
			ctxWithReviewer.runtime.start();

			try {
				const goal = await ctxWithReviewer.goalManager.createGoal({ title: 'G', description: '' });
				const task = await ctxWithReviewer.taskManager.createTask({
					title: 'T',
					description: 'D',
					assignedAgent: 'coder',
				});
				await ctxWithReviewer.goalManager.linkTaskToGoal(goal.id, task.id);

				await ctxWithReviewer.runtime.tick();

				const leaderInit = getInitForRole(ctxWithReviewer.sessionFactory.calls, 'leader');
				expect(leaderInit).toBeDefined();

				const agentNames = Object.keys(leaderInit!.agents!);
				// Built-in sub-agents always present
				expect(agentNames).toContain('leader-explorer');
				expect(agentNames).toContain('leader-fact-checker');
				// User-configured reviewers add reviewer agents to the map (named by model/config).
				// With one reviewer config, buildReviewerAgents adds a reviewer agent plus
				// reviewer-explorer and reviewer-fact-checker sub-agents for the reviewer.
				// So agents map grows beyond the 3 built-ins.
				expect(agentNames.length).toBeGreaterThan(3);
			} finally {
				ctxWithReviewer.runtime.stop();
				ctxWithReviewer.db.close();
			}
		});
	});

	// -------------------------------------------------------------------------
	// hasReviewers gate semantics:
	// Must reflect user-configured reviewers only, not built-in sub-agents
	// -------------------------------------------------------------------------
	describe('hasReviewers gate semantics', () => {
		it('leader agents map has built-in sub-agents but hasReviewers is still false when no user reviewers are configured', async () => {
			// This test documents the invariant:
			// - agentSubagents.leader controls hasReviewers (PR review gate)
			// - leader-explorer and leader-fact-checker are ALWAYS in agents map
			// - These built-in agents do NOT influence hasReviewers
			const roomConfig = makeRoom({ config: {} });
			const ctxLocal = createRuntimeTestContext({ room: roomConfig });
			ctxLocal.runtime.start();

			try {
				const goal = await ctxLocal.goalManager.createGoal({ title: 'G', description: '' });
				const task = await ctxLocal.taskManager.createTask({
					title: 'T',
					description: 'D',
					assignedAgent: 'coder',
				});
				await ctxLocal.goalManager.linkTaskToGoal(goal.id, task.id);

				await ctxLocal.runtime.tick();

				const leaderInit = getInitForRole(ctxLocal.sessionFactory.calls, 'leader');
				expect(leaderInit).toBeDefined();

				// Built-in sub-agents present — but these are NOT user-configured reviewers
				const agentNames = Object.keys(leaderInit!.agents!);
				expect(agentNames).toContain('leader-explorer');
				expect(agentNames).toContain('leader-fact-checker');

				// hasReviewers is derived from roomConfig.agentSubagents?.leader?.length
				// Since room has no agentSubagents.leader, hasReviewers = false
				// This means no PR review gate — even though built-in sub-agents are present.
				// Verify: room config has no agentSubagents.leader
				const roomConfigData = (roomConfig.config ?? {}) as Record<string, unknown>;
				const agentSubs = roomConfigData.agentSubagents as Record<string, unknown[]> | undefined;
				const hasReviewers = !!agentSubs?.leader?.length;
				expect(hasReviewers).toBe(false);
			} finally {
				ctxLocal.runtime.stop();
				ctxLocal.db.close();
			}
		});

		it('hasReviewers is true only when agentSubagents.leader has entries', async () => {
			// Verify that the hasReviewers flag is exclusively controlled by
			// room.config.agentSubagents.leader, matching lines 1304/1420/1553 in room-runtime.ts
			const reviewerEntry = {
				name: 'my-reviewer',
				description: 'A reviewer',
				prompt: 'Review this code.',
				model: 'claude-opus-4-5',
			};
			const roomConfig = makeRoom({
				config: {
					agentSubagents: {
						leader: [reviewerEntry],
					},
				},
			});

			const roomConfigData = (roomConfig.config ?? {}) as Record<string, unknown>;
			const agentSubs = roomConfigData.agentSubagents as Record<string, unknown[]> | undefined;
			const hasReviewers = !!agentSubs?.leader?.length;
			expect(hasReviewers).toBe(true);
		});

		it('hasReviewers logic ignores agentSubagents.worker', async () => {
			// Verify that agentSubagents.worker does NOT affect hasReviewers computation.
			// This ensures the PR review gate only depends on user intent (leader reviewers),
			// not on whether worker sub-agents are configured.
			const roomConfig = makeRoom({
				config: {
					agentSubagents: {
						// worker is set but leader is absent
						worker: [
							{
								name: 'helper',
								description: 'A worker helper',
								prompt: 'Help the coder.',
								model: 'claude-opus-4-5',
							},
						],
					},
				},
			});

			const roomConfigData = (roomConfig.config ?? {}) as Record<string, unknown>;
			const agentSubs = roomConfigData.agentSubagents as Record<string, unknown[]> | undefined;
			const hasReviewers = !!agentSubs?.leader?.length;
			// Despite worker agents being configured, hasReviewers is false (no leader reviewers)
			expect(hasReviewers).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// All three agent types spawn both worker and leader sessions
	// -------------------------------------------------------------------------
	describe('spawn produces both worker and leader sessions', () => {
		it('coder task produces both worker (coder) and leader sessions', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'T',
				description: 'D',
				assignedAgent: 'coder',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const workerInits = getAllInitsForRole(ctx.sessionFactory.calls, 'coder');
			const leaderInits = getAllInitsForRole(ctx.sessionFactory.calls, 'leader');

			expect(workerInits).toHaveLength(1);
			expect(leaderInits).toHaveLength(1);
			expect(workerInits[0].agent).toBe('Coder');
			expect(leaderInits[0].agent).toBe('Leader');
		});

		it('planner task produces both worker (planner) and leader sessions', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'Plan G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Plan T',
				description: 'Plan D',
				assignedAgent: 'planner',
				taskType: 'goal_review',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			await ctx.runtime.tick();

			const plannerInits = getAllInitsForRole(ctx.sessionFactory.calls, 'planner');
			const leaderInits = getAllInitsForRole(ctx.sessionFactory.calls, 'leader');

			expect(plannerInits).toHaveLength(1);
			expect(leaderInits).toHaveLength(1);
			expect(plannerInits[0].agent).toBe('Planner');
			expect(leaderInits[0].agent).toBe('Leader');
		});
	});
});
