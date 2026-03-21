import { describe, test, expect } from 'bun:test';
import {
	checkNotOnBaseBranch,
	checkPrExists,
	checkPrSynced,
	checkDraftTasksCreated,
	checkLeaderPrExists,
	checkPrHasReviews,
	checkPrIsMergeable,
	checkLeaderDraftsExist,
	checkWorkerPrMerged,
	checkLeaderPrMerged,
	checkLeaderRootRepoSynced,
	runWorkerExitGate,
	runLeaderCompleteGate,
	runLeaderSubmitGate,
	detectBypassMarker,
	BYPASS_GATES_MARKERS,
	closeStalePr,
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

describe('checkPrIsMergeable', () => {
	test('passes when PR is mergeable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when PR has mergeable === CONFLICTING (string)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'CONFLICTING',
					mergeStateStatus: 'CONFLICTING',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('merge conflicts');
		expect(result.bounceMessage).toContain('git rebase');
	});

	test('fails when PR has CONFLICTING mergeStateStatus', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: null,
					mergeStateStatus: 'CONFLICTING',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('merge conflicts');
	});

	test('fails when PR has DIRTY mergeStateStatus', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: null,
					mergeStateStatus: 'DIRTY',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('merge conflicts');
	});

	test('fails when CI checks are failing', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [
						{ name: 'build', conclusion: 'FAILURE' },
						{ name: 'test', conclusion: 'SUCCESS' },
					],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('CI checks failing');
		expect(result.reason).toContain('build');
	});

	test('fails when CI checks have timed out', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [{ name: 'lint', conclusion: 'TIMED_OUT' }],
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('CI checks failing');
		expect(result.reason).toContain('lint');
	});

	test('passes when git command fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when gh command fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: '',
				exitCode: 1,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when gh returns invalid JSON', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: 'not json',
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
		expect(result.pass).toBe(true);
	});

	test('passes when statusCheckRollup is null', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: null,
				}),
				exitCode: 0,
			},
		});
		const result = await checkPrIsMergeable(makeLeaderCtx(), opts);
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

	test('bounce message guides leader to send planner back for Phase 2', async () => {
		const result = await checkLeaderDraftsExist(makeLeaderCtx({ draftTaskCount: 0 }));
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
		expect(result.bounceMessage).toContain('create_task');
	});
});

describe('checkWorkerPrMerged', () => {
	test('passes when PR state is MERGED', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when PR state is OPEN', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('gh pr merge');
		expect(result.bounceMessage).toContain('OPEN');
		expect(result.bounceMessage).toContain('feat/add-alerts');
	});

	test('fails when PR state is CLOSED with reopen instructions', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'CLOSED', exitCode: 0 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('CLOSED');
		expect(result.bounceMessage).toContain('gh pr reopen');
		expect(result.bounceMessage).toContain('feat/add-alerts');
	});

	test('passes gracefully when git fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('passes gracefully when gh fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('passes gracefully when gh returns empty state with exit 0 (indeterminate)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 0 },
		});
		const result = await checkWorkerPrMerged(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});
});

describe('checkLeaderPrMerged', () => {
	test('passes when PR state is MERGED', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('fails when PR state is OPEN', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
		expect(result.bounceMessage).toContain('OPEN');
		expect(result.bounceMessage).toContain('feat/add-alerts');
	});

	test('fails when PR state is CLOSED with reopen instructions', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'CLOSED', exitCode: 0 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('CLOSED');
		expect(result.bounceMessage).toContain('gh pr reopen');
		expect(result.bounceMessage).toContain('feat/add-alerts');
	});

	test('passes gracefully when git fails', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('fails closed when gh fails and task is approved (no workerBypassed)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('gh command failed');
		expect(result.bounceMessage).toContain('gh');
	});

	test('passes gracefully when gh fails and task used bypass marker (workerBypassed=true)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await checkLeaderPrMerged(
			makeLeaderCtx({ approved: true, workerBypassed: true }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('passes gracefully when gh fails and task is not yet approved', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await checkLeaderPrMerged(
			makeLeaderCtx({ approved: false, workerBypassed: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('passes gracefully when gh returns empty state with exit 0 (indeterminate)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 0 },
		});
		const result = await checkLeaderPrMerged(makeLeaderCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
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

	test('runs general role PR hooks and passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/research-summary', exitCode: 0 },
			'gh pr list --head feat/research-summary --json number,url --state open': {
				stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
				exitCode: 0,
			},
			'git rev-parse HEAD': { stdout: 'abc123', exitCode: 0 },
			'gh pr view --json headRefOid --jq .headRefOid': { stdout: 'abc123', exitCode: 0 },
		});
		const result = await runWorkerExitGate(
			makeWorkerCtx({ workerRole: 'general', approved: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});
});

describe('runLeaderCompleteGate', () => {
	test('passes for coder tasks when PR is MERGED (no reviewers)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('checks reviews when hasReviewers is true and PR is MERGED with reviews', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
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
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
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
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
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

	test('passes for general tasks when PR is MERGED', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/research-summary', exitCode: 0 },
			'gh pr view feat/research-summary --json state --jq .state': {
				stdout: 'MERGED',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'general', taskType: 'research' }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('passes for phase 2 planning when PR is merged and drafts exist', async () => {
		// Phase 2: planner merged the plan PR and created draft tasks
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr view plan/new-feature --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'planner',
				taskType: 'planning',
				approved: true,
				draftTaskCount: 3,
			}),
			opts
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

	test('passes for coder tasks with approved when PR is MERGED', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
			}),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails for coder tasks with approved when PR is still OPEN (merge failed)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
			}),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
	});

	test('fails closed for approved coder tasks when gh unavailable (no workerBypassed)', async () => {
		// P1: once a human has approved a PR-based task, failing open would silently skip
		// merge verification. The gate must fail closed so the leader is forced to fix the
		// gh setup rather than completing the task without a verified merge.
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
			}),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('gh command failed');
	});

	test('passes gracefully for bypass tasks with approved when gh unavailable', async () => {
		// Bypass tasks (RESEARCH_ONLY etc.) have no PR — fail open is correct even with approved=true.
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				workerBypassed: true,
			}),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails for approved coder tasks when reviewers configured but no reviews posted', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '0',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				hasReviewers: true,
			}),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('reviewer sub-agents');
	});

	test('passes for approved coder tasks when reviewers configured and reviews posted', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
			'gh pr view feat/add-alerts --json reviews --jq .reviews | length': {
				stdout: '2',
				exitCode: 0,
			},
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				hasReviewers: true,
			}),
			opts
		);
		expect(result.pass).toBe(true);
	});
});

describe('runLeaderCompleteGate — PR merge validation (all roles)', () => {
	test('FAILS when PR is OPEN (not merged) for coder tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', approved: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('not merged');
		expect(result.bounceMessage).toContain('gh pr merge');
	});

	test('FAILS when PR is CLOSED (not merged) for coder tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'CLOSED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', approved: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('CLOSED');
	});

	test('FAILS when PR is OPEN (not merged) for general tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/research', exitCode: 0 },
			'gh pr view feat/research --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'general', approved: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('not merged');
	});

	test('PASSES when PR is MERGED for coder tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', approved: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('PASSES when PR is MERGED for general tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/research', exitCode: 0 },
			'gh pr view feat/research --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'general', approved: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('PASSES gracefully when gh is unavailable (fail open)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: '', exitCode: 1 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'coder', approved: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('FAILS when PR is OPEN (not merged) for planner tasks', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr view plan/new-feature --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({ workerRole: 'planner', taskType: 'planning', approved: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('send_to_worker');
	});

	test('PASSES when PR is MERGED for planner tasks but fails when no drafts exist', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr view plan/new-feature --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'planner',
				taskType: 'planning',
				approved: false,
				draftTaskCount: 0,
			}),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('create_task');
	});

	test('PASSES when PR is MERGED for planner tasks and drafts exist', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr view plan/new-feature --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'planner',
				taskType: 'planning',
				approved: false,
				draftTaskCount: 3,
			}),
			opts
		);
		expect(result.pass).toBe(true);
	});
});

describe('runWorkerExitGate — approved bypass', () => {
	test('passes for coder when approved and PR is MERGED', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(true);
	});

	test('fails for coder when approved but PR is still OPEN (merge did not happen)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'OPEN', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('gh pr merge');
	});

	test('fails for coder when approved but PR is CLOSED with reopen instructions', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr view feat/add-alerts --json state --jq .state': { stdout: 'CLOSED', exitCode: 0 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: true }), opts);
		expect(result.pass).toBe(false);
		expect(result.bounceMessage).toContain('gh pr reopen');
	});

	test('passes gracefully for coder when approved but git/gh unavailable', async () => {
		// When tools are unavailable, fail open (don't block)
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: '', exitCode: 1 },
		});
		const result = await runWorkerExitGate(makeWorkerCtx({ approved: true }), opts);
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
	test('checks PR for general tasks and passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/research-summary', exitCode: 0 },
			'gh pr list --head feat/research-summary --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'general', taskType: 'research' }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('checks PR for planner tasks and passes when PR exists', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'plan/new-feature', exitCode: 0 },
			'gh pr list --head plan/new-feature --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'planner', taskType: 'planning' }),
			opts
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

	test('checks mergeability and passes when PR is mergeable', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails when PR has merge conflicts', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'CONFLICTING',
					mergeStateStatus: 'CONFLICTING',
					statusCheckRollup: [],
				}),
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('merge conflicts');
	});

	test('fails when CI checks are failing', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
				}),
				exitCode: 0,
			},
		});
		const result = await runLeaderSubmitGate(
			makeLeaderCtx({ workerRole: 'coder', hasReviewers: false }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('CI checks failing');
	});

	test('checks mergeability before reviews when hasReviewers is true', async () => {
		// Mergeability check should come before review check
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-alerts', exitCode: 0 },
			'gh pr list --head feat/add-alerts --json number --state open': {
				stdout: '[{"number":1}]',
				exitCode: 0,
			},
			'gh pr view feat/add-alerts --json mergeable,mergeStateStatus,statusCheckRollup': {
				stdout: JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					statusCheckRollup: [],
				}),
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
});

describe('detectBypassMarker', () => {
	test('detects RESEARCH_ONLY marker at line start', () => {
		const output = 'RESEARCH_ONLY:\n\nHere is my research...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.RESEARCH_ONLY);
	});

	test('detects VERIFICATION_COMPLETE marker', () => {
		const output = 'VERIFICATION_COMPLETE:\n\nVerification complete...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.VERIFICATION_COMPLETE);
	});

	test('detects INVESTIGATION_RESULT marker', () => {
		const output = 'INVESTIGATION_RESULT:\n\nInvestigation findings...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.INVESTIGATION_RESULT);
	});

	test('detects ANALYSIS_COMPLETE marker', () => {
		const output = 'ANALYSIS_COMPLETE:\n\nAnalysis results...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.ANALYSIS_COMPLETE);
	});

	test('does NOT detect DOCUMENTATION_COMPLETE — writing docs requires file changes and must use git/PR', () => {
		// DOCUMENTATION_COMPLETE is intentionally excluded from bypass markers.
		// Documentation tasks involve writing/modifying files and must go through the normal workflow.
		const output = 'DOCUMENTATION_COMPLETE:\n\nDocumentation done.';
		expect(detectBypassMarker(output)).toBeNull();
	});

	test('detects marker with leading whitespace', () => {
		const output = '  VERIFICATION_COMPLETE:\n\nVerification complete...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.VERIFICATION_COMPLETE);
	});

	test('does NOT detect marker in the middle of output — only first non-empty line is checked', () => {
		// Security: a marker buried in analysis text or a code block should not trigger bypass.
		// Worker must explicitly start the response with the marker.
		const output = 'Some preamble text\n\nRESEARCH_ONLY:\n\nResearch findings...';
		expect(detectBypassMarker(output)).toBeNull();
	});

	test('detects marker when first line is empty (skips blank lines)', () => {
		// Leading blank lines are OK — the first *non-empty* line is checked
		const output = '\n\nRESEARCH_ONLY:\n\nResearch findings...';
		expect(detectBypassMarker(output)).toBe(BYPASS_GATES_MARKERS.RESEARCH_ONLY);
	});

	test('does NOT detect marker inside backtick code block on first line', () => {
		const output = '`RESEARCH_ONLY:` is a marker used for bypass.';
		expect(detectBypassMarker(output)).toBeNull();
	});

	test('returns null when no marker present', () => {
		const output = 'Regular worker output without any bypass marker';
		expect(detectBypassMarker(output)).toBeNull();
	});

	test('returns null for empty string', () => {
		expect(detectBypassMarker('')).toBeNull();
	});

	test('does not match partial marker (no colon)', () => {
		const output = 'RESEARCH_ONLY This text has no colon after the marker';
		expect(detectBypassMarker(output)).toBeNull();
	});
});

describe('runWorkerExitGate with bypass markers', () => {
	test('bypasses gate for coder role with RESEARCH_ONLY marker', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'coder',
			approved: false,
			workerOutput: 'RESEARCH_ONLY:\n\nResearch findings here.',
		});
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
		expect(result.bypassed).toBe(true);
		expect(result.reason).toContain('Bypassed');
		expect(result.reason).toContain('RESEARCH_ONLY:');
	});

	test('bypasses gate for general role with VERIFICATION_COMPLETE marker', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'general',
			approved: false,
			workerOutput: 'VERIFICATION_COMPLETE:\n\nAll checks passed.',
		});
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
		expect(result.bypassed).toBe(true);
		expect(result.reason).toContain('Bypassed');
	});

	test('does NOT bypass when no marker present — runs normal git checks', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'coder',
			approved: false,
			workerOutput: 'I implemented the feature and created a PR.',
		});
		// No git responses → git commands fail gracefully → passes
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
	});

	test('does NOT bypass when workerOutput is undefined', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'coder',
			approved: false,
			workerOutput: undefined,
		});
		// Gate runs normally; git fails gracefully → passes
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
	});

	test('does NOT bypass for planner role — planner bypass is unsupported', async () => {
		// Planners require draft task creation; bypassing the gate leaves the leader unable
		// to complete_task (needs tasks). Bypass is intentionally restricted to coder/general.
		const ctx = makeWorkerCtx({
			workerRole: 'planner',
			approved: false,
			draftTaskCount: 0,
			workerOutput: 'RESEARCH_ONLY:\n\nThis is a planning-related research task.',
		});
		// mockRunner({}) → git commands fail gracefully → normal planner pre-approval hooks pass
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
		expect(result.bypassed).toBeFalsy();
		expect(result.reason).toBeUndefined();
	});

	test('bypass not triggered when approved=true — post-approval path runs instead', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'coder',
			approved: true,
			workerOutput: 'RESEARCH_ONLY:\n\nResearch findings.',
		});
		// Post-approval: checks PR merge state; git fails gracefully → passes
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
	});

	test('bypasses gate with INVESTIGATION_RESULT marker and whitespace', async () => {
		const ctx = makeWorkerCtx({
			workerRole: 'coder',
			approved: false,
			workerOutput: '   INVESTIGATION_RESULT:   \n\nFound the root cause.',
		});
		const result = await runWorkerExitGate(ctx, mockRunner({}));
		expect(result.pass).toBe(true);
		expect(result.bypassed).toBe(true);
		expect(result.reason).toContain('Bypassed');
	});
});

describe('closeStalePr', () => {
	test('closes the old PR via URL with a superseded-by comment', async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const opts: HookOptions = {
			runCommand: async (args, cwd) => {
				calls.push({ args, cwd });
				return { stdout: '', exitCode: 0 };
			},
		};
		const result = await closeStalePr(
			'https://github.com/org/repo/pull/10',
			'https://github.com/org/repo/pull/20',
			'/workspace',
			opts
		);
		expect(result).toBe(true);
		expect(calls.length).toBe(1);
		// Uses the full URL, not just the PR number
		expect(calls[0].args).toEqual([
			'gh',
			'pr',
			'close',
			'https://github.com/org/repo/pull/10',
			'--comment',
			'Superseded by https://github.com/org/repo/pull/20',
		]);
		expect(calls[0].cwd).toBe('/workspace');
	});

	test('returns false when gh command fails', async () => {
		const opts: HookOptions = {
			runCommand: async () => ({ stdout: '', exitCode: 1 }),
		};
		const result = await closeStalePr(
			'https://github.com/org/repo/pull/10',
			'https://github.com/org/repo/pull/20',
			'/workspace',
			opts
		);
		expect(result).toBe(false);
	});

	test('returns false for invalid old PR URL (not a PR path)', async () => {
		const calls: Array<string[]> = [];
		const opts: HookOptions = {
			runCommand: async (args) => {
				calls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		};
		const result = await closeStalePr(
			'not-a-pr-url',
			'https://github.com/org/repo/pull/20',
			'/workspace',
			opts
		);
		expect(result).toBe(false);
		expect(calls.length).toBe(0);
	});

	test('returns false for empty old PR URL', async () => {
		const calls: Array<string[]> = [];
		const opts: HookOptions = {
			runCommand: async (args) => {
				calls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		};
		const result = await closeStalePr(
			'',
			'https://github.com/org/repo/pull/20',
			'/workspace',
			opts
		);
		expect(result).toBe(false);
		expect(calls.length).toBe(0);
	});
});

describe('checkLeaderRootRepoSynced', () => {
	test('skips when not approved (approved=false)', async () => {
		const calls: string[] = [];
		const opts: HookOptions = {
			runCommand: async (args) => {
				calls.push(args.join(' '));
				return { stdout: '', exitCode: 0 };
			},
		};
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: false, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(true);
		expect(calls.length).toBe(0);
	});

	test('skips when workerBypassed=true (bypass/research-only task)', async () => {
		const calls: string[] = [];
		const opts: HookOptions = {
			runCommand: async (args) => {
				calls.push(args.join(' '));
				return { stdout: '', exitCode: 0 };
			},
		};
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, workerBypassed: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(true);
		expect(calls.length).toBe(0);
	});

	test('passes when fetch and pull both succeed', async () => {
		const opts = mockRunner({
			'git symbolic-ref refs/remotes/origin/HEAD': {
				stdout: 'refs/remotes/origin/main',
				exitCode: 0,
			},
			'git fetch origin': { stdout: '', exitCode: 0 },
			'git pull origin main': { stdout: 'Already up to date.', exitCode: 0 },
		});
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails when git fetch origin fails', async () => {
		const opts = mockRunner({
			'git symbolic-ref refs/remotes/origin/HEAD': {
				stdout: 'refs/remotes/origin/main',
				exitCode: 0,
			},
			'git fetch origin': { stdout: '', exitCode: 1 },
		});
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('git fetch origin');
		expect(result.bounceMessage).toContain('git fetch origin');
	});

	test('fails when git pull fails', async () => {
		const opts = mockRunner({
			'git symbolic-ref refs/remotes/origin/HEAD': {
				stdout: 'refs/remotes/origin/dev',
				exitCode: 0,
			},
			'git fetch origin': { stdout: '', exitCode: 0 },
			'git pull origin dev': { stdout: 'error: merge conflict', exitCode: 1 },
		});
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('git pull origin dev');
		expect(result.bounceMessage).toContain('git pull origin dev');
	});

	test('passes fail-open when default branch cannot be determined', async () => {
		// All branch detection commands fail → cannot determine branch → pass gracefully
		const opts = mockRunner({});
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('falls back to BASE_BRANCHES when symbolic-ref fails', async () => {
		const opts = mockRunner({
			'git symbolic-ref refs/remotes/origin/HEAD': { stdout: '', exitCode: 1 },
			'git rev-parse --verify origin/main': { stdout: 'abc123', exitCode: 0 },
			'git fetch origin': { stdout: '', exitCode: 0 },
			'git pull origin main': { stdout: 'Already up to date.', exitCode: 0 },
		});
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({ approved: true, rootWorkspacePath: '/root/repo' }),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('runs all commands on rootWorkspacePath, not workspacePath', async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const opts: HookOptions = {
			runCommand: async (args, cwd) => {
				calls.push({ args, cwd });
				// Provide responses for all expected commands
				const key = args.join(' ');
				if (key === 'git symbolic-ref refs/remotes/origin/HEAD') {
					return { stdout: 'refs/remotes/origin/main', exitCode: 0 };
				}
				if (key === 'git fetch origin') return { stdout: '', exitCode: 0 };
				if (key === 'git pull origin main') return { stdout: '', exitCode: 0 };
				return { stdout: '', exitCode: 1 };
			},
		};
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({
				approved: true,
				workspacePath: '/tmp/task-worktree',
				rootWorkspacePath: '/root/main-repo',
			}),
			opts
		);
		expect(result.pass).toBe(true);
		// Every git command must have run in rootWorkspacePath
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.cwd).toBe('/root/main-repo');
		}
	});

	test('falls back to workspacePath when rootWorkspacePath is not provided', async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const opts: HookOptions = {
			runCommand: async (args, cwd) => {
				calls.push({ args, cwd });
				const key = args.join(' ');
				if (key === 'git symbolic-ref refs/remotes/origin/HEAD') {
					return { stdout: 'refs/remotes/origin/main', exitCode: 0 };
				}
				if (key === 'git fetch origin') return { stdout: '', exitCode: 0 };
				if (key === 'git pull origin main') return { stdout: '', exitCode: 0 };
				return { stdout: '', exitCode: 1 };
			},
		};
		const result = await checkLeaderRootRepoSynced(
			makeLeaderCtx({
				approved: true,
				workspacePath: '/tmp/task-worktree',
				// rootWorkspacePath intentionally omitted
			}),
			opts
		);
		expect(result.pass).toBe(true);
		// Should fall back to workspacePath
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.cwd).toBe('/tmp/task-worktree');
		}
	});
});

describe('runLeaderCompleteGate — root repo sync after PR merge', () => {
	test('passes end-to-end when PR merged and root repo synced successfully', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-feature', exitCode: 0 },
			'gh pr view feat/add-feature --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
			'git symbolic-ref refs/remotes/origin/HEAD': {
				stdout: 'refs/remotes/origin/main',
				exitCode: 0,
			},
			'git fetch origin': { stdout: '', exitCode: 0 },
			'git pull origin main': { stdout: 'Already up to date.', exitCode: 0 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				rootWorkspacePath: '/root/main-repo',
			}),
			opts
		);
		expect(result.pass).toBe(true);
	});

	test('fails when PR merged but git fetch fails (sync error)', async () => {
		const opts = mockRunner({
			'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-feature', exitCode: 0 },
			'gh pr view feat/add-feature --json state --jq .state': { stdout: 'MERGED', exitCode: 0 },
			'git symbolic-ref refs/remotes/origin/HEAD': {
				stdout: 'refs/remotes/origin/main',
				exitCode: 0,
			},
			'git fetch origin': { stdout: '', exitCode: 1 },
		});
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				rootWorkspacePath: '/root/main-repo',
			}),
			opts
		);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain('git fetch origin');
		expect(result.bounceMessage).toContain('complete_task');
	});

	test('root sync runs on rootWorkspacePath, not the task worktree', async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const opts: HookOptions = {
			runCommand: async (args, cwd) => {
				calls.push({ args, cwd });
				const key = args.join(' ');
				if (key === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'feat/foo', exitCode: 0 };
				if (key === 'gh pr view feat/foo --json state --jq .state')
					return { stdout: 'MERGED', exitCode: 0 };
				if (key === 'git symbolic-ref refs/remotes/origin/HEAD')
					return { stdout: 'refs/remotes/origin/dev', exitCode: 0 };
				if (key === 'git fetch origin') return { stdout: '', exitCode: 0 };
				if (key === 'git pull origin dev') return { stdout: '', exitCode: 0 };
				return { stdout: '', exitCode: 1 };
			},
		};
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				workspacePath: '/tmp/task-worktree',
				rootWorkspacePath: '/root/main-repo',
			}),
			opts
		);
		expect(result.pass).toBe(true);
		// PR check runs in the task worktree (to get branch name)
		const prCheckCall = calls.find(
			(c) =>
				c.args.includes('rev-parse') && c.args.includes('--abbrev-ref') && c.args.includes('HEAD')
		);
		expect(prCheckCall?.cwd).toBe('/tmp/task-worktree');
		// Root sync commands run in rootWorkspacePath
		const syncCalls = calls.filter(
			(c) => c.args.includes('fetch') || c.args.includes('pull') || c.args.includes('symbolic-ref')
		);
		expect(syncCalls.length).toBeGreaterThan(0);
		for (const call of syncCalls) {
			expect(call.cwd).toBe('/root/main-repo');
		}
	});

	test('skip root sync for bypass tasks even when approved', async () => {
		const calls: string[] = [];
		const opts: HookOptions = {
			runCommand: async (args) => {
				calls.push(args.join(' '));
				const key = args.join(' ');
				if (key === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'feat/foo', exitCode: 0 };
				// bypass tasks — gh fails open
				return { stdout: '', exitCode: 1 };
			},
		};
		const result = await runLeaderCompleteGate(
			makeLeaderCtx({
				workerRole: 'coder',
				taskType: 'coding',
				approved: true,
				workerBypassed: true,
				rootWorkspacePath: '/root/main-repo',
			}),
			opts
		);
		expect(result.pass).toBe(true);
		// Sync commands (fetch, pull, symbolic-ref) must NOT have been called
		const syncCalled = calls.some(
			(c) => c.includes('fetch') || c.includes('pull') || c.includes('symbolic-ref')
		);
		expect(syncCalled).toBe(false);
	});
});
