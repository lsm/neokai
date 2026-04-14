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
	spawnAndRouteToLeader,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session';

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

			// Leader init should have plan_review context embedded in the Leader agent's system prompt.
			// The discriminating string only appears when reviewContext === 'plan_review'
			// (see leaderRoleIntro() in leader-agent.ts — code_review uses "reviewing work done by a worker agent").
			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();
			expect(leaderInit!.agent).toBe('Leader');
			const leaderAgentDef = leaderInit!.agents!['Leader'];
			expect(leaderAgentDef).toBeDefined();
			expect(leaderAgentDef.prompt).toContain('reviewing a plan created by a Planner Agent');
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
				// One reviewer config with model 'claude-opus-4-5' produces 'reviewer-opus'
				// (via toReviewerName → toShortModelName in leader-agent.ts).
				// buildReviewerAgents also seeds reviewer-explorer and reviewer-fact-checker
				// for that reviewer, giving exactly 6 agents total:
				//   Leader, leader-explorer, leader-fact-checker,
				//   reviewer-opus, reviewer-explorer, reviewer-fact-checker
				expect(agentNames).toContain('reviewer-opus');
				expect(agentNames).toHaveLength(6);
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
		it('leader agents map always has built-in sub-agents even when no user reviewers are configured', async () => {
			// The leader agents map always contains leader-explorer and leader-fact-checker
			// regardless of whether agentSubagents.leader is populated.
			// These built-in sub-agents are separate from user-configured reviewers:
			// their presence in the agents map does NOT trigger the PR review gate.
			const { group: _ } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });

			const leaderInit = getInitForRole(ctx.sessionFactory.calls, 'leader');
			expect(leaderInit).toBeDefined();

			// Built-in sub-agents always present (not user-configured reviewers)
			const agentNames = Object.keys(leaderInit!.agents!);
			expect(agentNames).toContain('leader-explorer');
			expect(agentNames).toContain('leader-fact-checker');

			// No user reviewer agents — only the 3 built-ins
			expect(agentNames).toHaveLength(3);
		});

		it('rooms with agentSubagents.leader invoke checkPrHasReviews during submit_for_review', async () => {
			// Verify that the production hasReviewers derivation in room-runtime.ts (lines 1553-1554)
			// causes the checkPrHasReviews gate to be reached when agentSubagents.leader is populated.
			//
			// Strategy: use a runCommand spy that makes git rev-parse succeed (to avoid
			// checkPrHasReviews short-circuiting early) and all other commands fail open.
			// Then assert that the unique 'gh pr view --json reviews' command was invoked.
			const recordedCommands: string[][] = [];
			const ctxWithReviewer = createRuntimeTestContext({
				room: makeRoom({
					config: {
						agentSubagents: {
							leader: [
								{
									name: 'my-reviewer',
									description: 'A reviewer',
									prompt: 'Review this code.',
									model: 'claude-opus-4-5',
								},
							],
						},
					},
				}),
				hookOptions: {
					runCommand: async (args) => {
						recordedCommands.push(args);
						// Make git rev-parse succeed so checkPrHasReviews does not short-circuit
						if (args[0] === 'git' && args[1] === 'rev-parse') {
							return { stdout: 'feature-branch', exitCode: 0 };
						}
						// All other commands fail open (exit 1 → pass: true in each hook)
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			const { group } = await spawnAndRouteToLeader(ctxWithReviewer, {
				assignedAgent: 'coder',
			});
			await ctxWithReviewer.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			// checkPrHasReviews calls: gh pr view <branch> --json reviews --jq ...
			// This is the ONLY gate that includes 'reviews' in the gh pr view command.
			const reviewsGateInvoked = recordedCommands.some(
				(args) => args[0] === 'gh' && args[2] === 'view' && args.includes('reviews')
			);
			expect(reviewsGateInvoked).toBe(true);

			ctxWithReviewer.runtime.stop();
			ctxWithReviewer.db.close();
		});

		it('rooms without agentSubagents.leader skip the checkPrHasReviews gate entirely', async () => {
			// Verify that the production hasReviewers derivation in room-runtime.ts (lines 1553-1554)
			// does NOT invoke checkPrHasReviews when agentSubagents.leader is absent.
			//
			// Same spy setup — git rev-parse succeeds so the gate WOULD be reached if hasReviewers
			// were true. Since it is false, the 'gh pr view --json reviews' command must not appear.
			const recordedCommands: string[][] = [];
			const ctxNoReviewer = createRuntimeTestContext({
				room: makeRoom({ config: {} }),
				hookOptions: {
					runCommand: async (args) => {
						recordedCommands.push(args);
						if (args[0] === 'git' && args[1] === 'rev-parse') {
							return { stdout: 'feature-branch', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			const { group } = await spawnAndRouteToLeader(ctxNoReviewer, {
				assignedAgent: 'coder',
			});
			await ctxNoReviewer.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			const reviewsGateInvoked = recordedCommands.some(
				(args) => args[0] === 'gh' && args[2] === 'view' && args.includes('reviews')
			);
			expect(reviewsGateInvoked).toBe(false);

			ctxNoReviewer.runtime.stop();
			ctxNoReviewer.db.close();
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
