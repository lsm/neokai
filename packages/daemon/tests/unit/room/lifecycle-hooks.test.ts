import { describe, test, expect } from 'bun:test';
import {
	checkNotOnBaseBranch,
	checkPrExists,
	checkPrSynced,
	checkDraftTasksCreated,
	checkLeaderPrExists,
	checkPrHasReviews,
	checkLeaderDraftsExist,
	runWorkerExitGate,
	runLeaderCompleteGate,
	runLeaderSubmitGate,
	type WorkerExitHookContext,
	type LeaderCompleteHookContext,
	type HookOptions,
} from '../../../src/lib/room/runtime/lifecycle-hooks';

// Helper to create a mock command runner
function mockRunner(responses: Record<string, { stdout: string; exitCode: number }>): HookOptions {
	return {
		runCommand: async (args: string[], _cwd: string) => {
			const key = args.join(' ');
			return responses[key] ?? { stdout: '', exitCode: 1 };
		},
	};
}

function makeWorkerCtx(overrides?: Partial<WorkerExitHookContext>): WorkerExitHookContext {
	return {
		workspacePath: '/tmp/test-worktree',
		taskType: 'coding',
		workerRole: 'coder',
		taskId: 'task-1',
		groupId: 'group-1',
		...overrides,
	};
}

function makeLeaderCtx(overrides?: Partial<LeaderCompleteHookContext>): LeaderCompleteHookContext {
	return {
		workspacePath: '/tmp/test-worktree',
		taskType: 'coding',
		workerRole: 'coder',
		taskId: 'task-1',
		groupId: 'group-1',
		hasReviewers: false,
		...overrides,
	};
}

describe('checkNotOnBaseBranch', () => {
	test('passes when on a feature branch', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
		});
		const result = await checkNotOnBaseBranch(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when on main', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'main', exitCode: 0 },
		});
		const result = await checkNotOnBaseBranch(makeWorkerCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('feature branch');
	});

	test('fails when on dev', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'dev', exitCode: 0 },
		});
		const result = await checkNotOnBaseBranch(makeWorkerCtx(), opts);
		expect(result.pass).toBe(false);
	});

	test('fails when on master', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'master', exitCode: 0 },
		});
		const result = await checkNotOnBaseBranch(makeWorkerCtx(), opts);
		expect(result.pass).toBe(false);
	});

	test('passes gracefully when git fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await checkNotOnBaseBranch(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkPrExists', () => {
	test('passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number,url --state open': {
				stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
				exitCode: 0,
			},
		});
		const result = await checkPrExists(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when no PR', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number,url --state open': {
				stdout: '[]',
				exitCode: 0,
			},
		});
		const result = await checkPrExists(makeWorkerCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('gh pr create');
	});

	test('passes when gh unavailable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number,url --state open': {
				stdout: '',
				exitCode: 1,
			},
		});
		const result = await checkPrExists(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when gh returns invalid JSON', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number,url --state open': {
				stdout: 'not json',
				exitCode: 0,
			},
		});
		const result = await checkPrExists(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkPrSynced', () => {
	test('passes when SHAs match', async () => {
		const opts = mockRunner({
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: 'abc123', exitCode: 0 },
		});
		const result = await checkPrSynced(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when SHAs differ', async () => {
		const opts = mockRunner({
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: 'def456', exitCode: 0 },
		});
		const result = await checkPrSynced(makeWorkerCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('git push');
	});

	test('passes when git fails', async () => {
		const opts = mockRunner({
			'git rev-parse HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await checkPrSynced(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when gh fails', async () => {
		const opts = mockRunner({
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: '', exitCode: 1 },
		});
		const result = await checkPrSynced(makeWorkerCtx(), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkDraftTasksCreated', () => {
	test('passes when draftTaskCount > 0', async () => {
		const result = await checkDraftTasksCreated(makeWorkerCtx({ draftTaskCount: 3 }));
		expect(result.pass).toBe(true);
	});

	test('fails when draftTaskCount === 0', async () => {
		const result = await checkDraftTasksCreated(makeWorkerCtx({ draftTaskCount: 0 }));
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('create_task');
	});

	test('fails when draftTaskCount undefined', async () => {
		const result = await checkDraftTasksCreated(makeWorkerCtx({ draftTaskCount: undefined }));
		expect(result.pass).toBe(false);
	});
});

describe('checkLeaderPrExists', () => {
	test('passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await checkLeaderPrExists(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when no PR', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[]',
				exitCode: 0,
			},
		});
		const result = await checkLeaderPrExists(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
	});

	test('passes when gh unavailable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '',
				exitCode: 1,
			},
		});
		const result = await checkLeaderPrExists(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkPrHasReviews', () => {
	test('passes when reviews > 0', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '2',
				exitCode: 0,
			},
		});
		const result = await checkPrHasReviews(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when reviews === 0', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '0',
				exitCode: 0,
			},
		});
		const result = await checkPrHasReviews(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('reviewer sub-agents');
	});

	test('passes when gh unavailable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '',
				exitCode: 1,
			},
		});
		const result = await checkPrHasReviews(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when gh returns non-numeric (NaN graceful)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: 'error',
				exitCode: 0,
			},
		});
		const result = await checkPrHasReviews(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkLeaderDraftsExist', () => {
	test('passes when draftTaskCount > 0', async () => {
		const result = await checkLeaderDraftsExist(makeLeaderCtx({ draftTaskCount: 2 }));
		expect(result.pass).toBe(true);
	});

	test('fails when draftTaskCount === 0', async () => {
		const result = await checkLeaderDraftsExist(makeLeaderCtx({ draftTaskCount: 0 }));
		expect(result.pass).toBe(false);
	});
});

describe('runWorkerExitGate', () => {
	test('runs coder hooks and passes when all succeed', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number,url --state open': {
				stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
				exitCode: 0,
			},
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: 'abc123', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ workerRole: 'coder' }), opts);
		expect(result.pass).toBe(true);
	});

	test('stops at first coder failure when on main branch', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'main', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ workerRole: 'coder' }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('feature branch');
	});

	test('runs planner phase 2 hook and passes when tasks exist', async () => {
		const result = await runWorkerExitGate(
			makeWorkerCtx({ workerRole: 'planner', draftTaskCount: 3, approved: true })
		);
		expect(result.pass).toBe(true);
	});

	test('fails planner phase 2 with no tasks', async () => {
		const result = await runWorkerExitGate(
			makeWorkerCtx({ workerRole: 'planner', draftTaskCount: 0, approved: true })
		);
		expect(result.pass).toBe(false);
	});

	test('runs planner phase 1 hooks (PR check) and passes', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr list --head plan/new-feature --json number,url --state open': {
				stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
				exitCode: 0,
			},
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: 'abc123', exitCode: 0 },
		});
		const result = await runWorkerExitGate(
			makeWorkerCtx({ workerRole: 'planner', approved: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails planner phase 1 when no PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr list --head plan/new-feature --json number,url --state open': {
				stdout: '[]',
				exitCode: 0,
			},
		});
		const result = await runWorkerExitGate(
			makeWorkerCtx({ workerRole: 'planner', approved: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('gh pr create');
	});

	test('passes for general role with no applicable hooks', async () => {
		const result = await runWorkerExitGate(makeWorkerCtx({ workerRole: 'general' }));
		expect(result.pass).toBe(true);
	});
});

describe('runLeaderCompleteGate', () => {
	test('checks PR for coder tasks and passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('checks reviews when hasReviewers is true and reviews exist', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '2',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: true }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails when no reviews and hasReviewers is true', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '0',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: true }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('reviewer sub-agents');
	});

	test('skips review check when hasReviewers is false', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('checks drafts for planning tasks and passes when drafts exist', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ taskType: 'planning', draftTaskCount: 2 })
		);
		expect(result.pass).toBe(true);
	});

	test('fails planning tasks with no drafts', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ taskType: 'planning', draftTaskCount: 0 })
		);
		expect(result.pass).toBe(false);
	});

	test('passes for general tasks with no applicable hooks', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'general', taskType: 'research' })
		);
		expect(result.pass).toBe(true);
	});

	test('skips PR checks for phase 2 planning (approved=true) and passes with drafts', async () => {
		// Phase 2: PR was already merged, no open PR — but approved skips PR checks
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'planner',
				taskType: 'planning',
				approved: true,
				draftTaskCount: 3,
			})
		);
		expect(result.pass).toBe(true);
	});

	test('fails phase 2 planning when no drafts exist despite approved', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'planner',
				taskType: 'planning',
				approved: true,
				draftTaskCount: 0,
			})
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('create_task');
	});

	test('passes for non-planning tasks with approved (edge case)', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
			})
		);
		expect(result.pass).toBe(true);
	});

	test('passes for coder tasks with approved (PR already merged by worker)', async () => {
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
			})
		);
		expect(result.pass).toBe(true);
	});
});

describe('runWorkerExitGate — approved bypass', () => {
	test('passes for coder when approved is true (post-merge exit)', async () => {
		// No mock runner — would fail branch/PR checks without approved
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: true }));
		expect(result.pass).toBe(true);
	});

	test('still enforces checks for coder when approved is false', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'main', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: false }), opts);
		expect(result.pass).toBe(false);
	});
});

describe('runLeaderSubmitGate', () => {
	test('passes for non-coder tasks without checking PR', async () => {
		// General task — no git/gh checks should run
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'general', taskType: 'research' })
		);
		expect(result.pass).toBe(true);
	});

	test('passes for planner tasks without checking PR', async () => {
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'planner', taskType: 'planning' })
		);
		expect(result.pass).toBe(true);
	});

	test('passes for coder tasks when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(makeLeaderCtx({ workerRole: 'coder' }), opts);
		expect(result.pass).toBe(true);
	});

	test('fails for coder tasks when no PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[]',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(makeLeaderCtx({ workerRole: 'coder' }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
	});

	test('passes gracefully for coder tasks when gh is unavailable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '',
				exitCode: 1,
			},
		});
		const result = await runLeaderSubmitGate(makeLeaderCtx({ workerRole: 'coder' }), opts);
		expect(result.pass).toBe(true);
	});

	test('checks reviews when hasReviewers is true and reviews exist', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '2',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: true }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails when hasReviewers is true but no reviews posted', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '0',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: true }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('reviewer sub-agents');
	});

	test('skips review check when hasReviewers is false', async () => {
		// PR exists but no reviews — should still pass because hasReviewers is false
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});
});
