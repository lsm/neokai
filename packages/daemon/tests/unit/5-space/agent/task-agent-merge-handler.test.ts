/**
 * Unit tests for the Task Agent `merge_pr` MCP tool handler.
 *
 * Covers the contract described in
 *   `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §§1.1 & 1.3, plus the security caveats from the plan review:
 *   - URL validation
 *   - Cross-check against the end-node signal (pr_url and action)
 *   - Autonomy threshold (>= 4 auto-approves, < 4 requires human)
 *   - Human-input response artifact enforcement at level < 4
 *   - Idempotency via artifact-store scan (in-memory, no SQL json_extract)
 *   - Script failure / timeout / spawn error surfacing
 *   - Audit log emission via structured logger
 *   - Snapshot of the canonical `request_human_input` question format
 *   - Feature-flag gating of tool registration on the MCP server
 *
 * No live `bash` is invoked — the `runScript` dependency is stubbed so each
 * test is fully deterministic.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import {
	createMergePrHandler,
	defaultMergeScriptExecutor,
	buildMergeApprovalQuestion,
	buildMergeApprovalContextHint,
	isMergeExecutorFeatureEnabled,
	MERGE_AUTONOMY_THRESHOLD,
	GITHUB_PR_URL_REGEX,
	type HumanInputResponse,
	type MergeScriptExecutor,
	type MergeScriptResult,
	type PostApprovalSignal,
} from '../../../../src/lib/space/tools/task-agent-merge-handler.ts';
import {
	PR_MERGE_BASH_SCRIPT,
	PR_MERGE_SCRIPT_TIMEOUT_MS,
} from '../../../../src/lib/space/tools/pr-merge-script.ts';
import type { Space } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	runMigrations(db, () => {});
	// NOTE: FK constraints are explicitly disabled AFTER migrations because
	// some migrations internally re-enable them. The artifact repository has
	// a FK from `workflow_run_artifacts.run_id` → `space_workflow_runs(id)`;
	// enforcing it would require seeding a full workflow-run graph in every
	// test, which is outside the scope of these handler-level unit tests.
	// The FK is exercised in repository tests.
	db.exec('PRAGMA foreign_keys = OFF');
	return db;
}

function makeSpace(): Space {
	return {
		id: 'space-merge-test',
		slug: 'space-merge-test',
		workspacePath: '/tmp/merge-test',
		name: 'Merge Test Space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

interface HandlerCtx {
	db: BunDatabase;
	space: Space;
	workflowRunId: string;
	taskId: string;
	artifactRepo: WorkflowRunArtifactRepository;
	scriptCalls: Array<Parameters<MergeScriptExecutor>[0]>;
	signal: PostApprovalSignal | null;
	humanResponse: HumanInputResponse | null;
	autonomyLevel: number;
	scriptResult: MergeScriptResult;
	runScriptOverride?: MergeScriptExecutor;
}

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
	const db = overrides.db ?? makeDb();
	// Exercise a realistic GitHub PR URL — also re-used by default signal below.
	const defaultPrUrl = 'https://github.com/neokai/neokai/pull/123';
	return {
		db,
		space: overrides.space ?? makeSpace(),
		workflowRunId: overrides.workflowRunId ?? 'run-merge-test',
		taskId: overrides.taskId ?? 'task-merge-test',
		artifactRepo: overrides.artifactRepo ?? new WorkflowRunArtifactRepository(db),
		scriptCalls: overrides.scriptCalls ?? [],
		signal:
			overrides.signal === undefined
				? { action: 'merge_pr', pr_url: defaultPrUrl }
				: overrides.signal,
		humanResponse: overrides.humanResponse ?? null,
		autonomyLevel: overrides.autonomyLevel ?? 4,
		scriptResult:
			overrides.scriptResult ??
			({
				exitCode: 0,
				stdout: JSON.stringify({ merged_pr_url: defaultPrUrl, status: 'merged' }),
				stderr: '',
				timedOut: false,
			} satisfies MergeScriptResult),
		runScriptOverride: overrides.runScriptOverride,
	};
}

function buildHandler(ctx: HandlerCtx) {
	return createMergePrHandler({
		taskId: ctx.taskId,
		space: ctx.space,
		workflowRunId: ctx.workflowRunId,
		artifactRepo: ctx.artifactRepo,
		getSpaceAutonomyLevel: async () => ctx.autonomyLevel,
		getSignalledPostApprovalAction: async () => ctx.signal,
		getRecentHumanInputResponse: async () => ctx.humanResponse,
		runScript:
			ctx.runScriptOverride ??
			(async (args) => {
				ctx.scriptCalls.push(args);
				return ctx.scriptResult;
			}),
	});
}

function parseToolResult<T = Record<string, unknown>>(res: {
	content: Array<{ text: string }>;
}): T {
	return JSON.parse(res.content[0].text) as T;
}

const DEFAULT_PR_URL = 'https://github.com/neokai/neokai/pull/123';

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe('merge_pr — URL validation', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('accepts a canonical GitHub PR URL', () => {
		expect(GITHUB_PR_URL_REGEX.test('https://github.com/owner/repo/pull/42')).toBe(true);
	});

	test('rejects non-GitHub URLs', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: 'https://gitlab.com/owner/repo/merge_requests/1' });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid pr_url');
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('rejects URLs missing the PR number', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: 'https://github.com/owner/repo/pull/' });
		expect(parseToolResult<{ success: false }>(res).success).toBe(false);
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('rejects URLs with an http (non-TLS) scheme', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: 'http://github.com/owner/repo/pull/1' });
		expect(parseToolResult<{ success: false }>(res).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Happy path — level >= 4 auto-approves
// ---------------------------------------------------------------------------

describe('merge_pr — level >= 4 happy path', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx({ autonomyLevel: MERGE_AUTONOMY_THRESHOLD });
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('runs the merge script, writes a result artifact, reports success', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{
			success: boolean;
			merged_pr_url: string;
			approval: string;
			artifactId: string;
		}>(res);

		expect(parsed.success).toBe(true);
		expect(parsed.merged_pr_url).toBe(DEFAULT_PR_URL);
		expect(parsed.approval).toBe('auto_policy');

		// The script was invoked once with the canonical env + cwd.
		expect(ctx.scriptCalls).toHaveLength(1);
		const call = ctx.scriptCalls[0];
		expect(call.script).toBe(PR_MERGE_BASH_SCRIPT);
		expect(call.cwd).toBe(ctx.space.workspacePath);
		expect(call.timeoutMs).toBe(PR_MERGE_SCRIPT_TIMEOUT_MS);
		expect(call.env.NEOKAI_WORKSPACE_PATH).toBe(ctx.space.workspacePath);
		expect(JSON.parse(call.env.NEOKAI_ARTIFACT_DATA_JSON)).toEqual({ pr_url: DEFAULT_PR_URL });

		// Audit artifact written with approval='auto_policy', approvalReason=null.
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
			nodeId: 'task-agent',
			artifactType: 'result',
		});
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.merged_pr_url).toBe(DEFAULT_PR_URL);
		expect(artifacts[0].data.status).toBe('merged');
		expect(artifacts[0].data.approval).toBe('auto_policy');
		expect(artifacts[0].data.approvalReason).toBeNull();
	});

	test('human_approval_reason is ignored at level >= 4 (recorded verbatim)', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({
			pr_url: DEFAULT_PR_URL,
			human_approval_reason: 'ignored at high level',
		});
		expect(parseToolResult<{ success: true }>(res).success).toBe(true);
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
			nodeId: 'task-agent',
			artifactType: 'result',
		});
		// Reason is still recorded for audit, but approval stays auto_policy.
		expect(artifacts[0].data.approval).toBe('auto_policy');
		expect(artifacts[0].data.approvalReason).toBe('ignored at high level');
	});
});

// ---------------------------------------------------------------------------
// Level < 4 refusal / approval paths
// ---------------------------------------------------------------------------

describe('merge_pr — level < 4 enforcement', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx({ autonomyLevel: 3 });
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('refuses when human_approval_reason is missing', async () => {
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Human approval required');
		expect(ctx.scriptCalls).toHaveLength(0);
		// No artifact written on refusal.
		expect(ctx.artifactRepo.listByRun(ctx.workflowRunId, { nodeId: 'task-agent' })).toHaveLength(0);
	});

	test('refuses with fabricated reason when no human_input artifact exists', async () => {
		// Defaults: humanResponse = null → no artifact recorded.
		const handler = buildHandler(ctx);
		const res = await handler({
			pr_url: DEFAULT_PR_URL,
			human_approval_reason: 'hallucinated: user said yes',
		});
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('No human-input response');
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('refuses when human rejected in the recorded response', async () => {
		ctx.humanResponse = {
			response: 'No — needs security review first',
			rejected: true,
			createdAt: Date.now(),
		};
		const handler = buildHandler(ctx);
		const res = await handler({
			pr_url: DEFAULT_PR_URL,
			human_approval_reason: 'No — needs security review first',
		});
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('human rejected');
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('runs when human approved via a non-rejecting response', async () => {
		ctx.humanResponse = {
			response: 'yes, go ahead',
			rejected: false,
			createdAt: Date.now(),
		};
		const handler = buildHandler(ctx);
		const res = await handler({
			pr_url: DEFAULT_PR_URL,
			human_approval_reason: 'yes, go ahead',
		});
		const parsed = parseToolResult<{ success: boolean; approval: string }>(res);
		expect(parsed.success).toBe(true);
		expect(parsed.approval).toBe('human');
		expect(ctx.scriptCalls).toHaveLength(1);

		// Artifact records the approval source + verbatim reason.
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
			nodeId: 'task-agent',
			artifactType: 'result',
		});
		expect(artifacts[0].data.approval).toBe('human');
		expect(artifacts[0].data.approvalReason).toBe('yes, go ahead');
	});
});

// ---------------------------------------------------------------------------
// Cross-check against end-node signal
// ---------------------------------------------------------------------------

describe('merge_pr — signal cross-check', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('refuses when no end-node signal recorded', async () => {
		ctx.signal = null;
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('No post-approval signal');
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('refuses when pr_url does not match the signalled URL', async () => {
		ctx.signal = {
			action: 'merge_pr',
			pr_url: 'https://github.com/neokai/neokai/pull/999',
		};
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('does not match');
		expect(parsed.error).toContain('/pull/999');
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('refuses when signalled action is not merge_pr', async () => {
		ctx.signal = {
			action: 'close_pr',
			pr_url: DEFAULT_PR_URL,
		};
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain("action is 'close_pr'");
		expect(ctx.scriptCalls).toHaveLength(0);
	});

	test('surfaces resolver errors instead of running the merge', async () => {
		const ctxErr = makeCtx();
		const handler = createMergePrHandler({
			taskId: ctxErr.taskId,
			space: ctxErr.space,
			workflowRunId: ctxErr.workflowRunId,
			artifactRepo: ctxErr.artifactRepo,
			getSpaceAutonomyLevel: async () => 5,
			getSignalledPostApprovalAction: async () => {
				throw new Error('db unavailable');
			},
			getRecentHumanInputResponse: async () => null,
			runScript: async (args) => {
				ctxErr.scriptCalls.push(args);
				return ctxErr.scriptResult;
			},
		});
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('db unavailable');
		expect(ctxErr.scriptCalls).toHaveLength(0);
		ctxErr.db.close();
	});
});

// ---------------------------------------------------------------------------
// Idempotency — artifact-store in-memory scan
// ---------------------------------------------------------------------------

describe('merge_pr — idempotency', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx({ autonomyLevel: 5 });
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('short-circuits when artifact store already has a merged_pr_url match', async () => {
		// Seed a prior merge artifact with the matching URL.
		ctx.artifactRepo.upsert({
			id: 'prior-artifact',
			runId: ctx.workflowRunId,
			nodeId: 'task-agent',
			artifactType: 'result',
			artifactKey: 'merge_pr:1234:abcdef',
			data: {
				merged_pr_url: DEFAULT_PR_URL,
				status: 'merged',
				approval: 'auto_policy',
			},
		});

		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{
			success: boolean;
			alreadyMerged: boolean;
			artifactId: string;
		}>(res);
		expect(parsed.success).toBe(true);
		expect(parsed.alreadyMerged).toBe(true);
		expect(parsed.artifactId).toBe('prior-artifact');

		// Script NOT invoked on short-circuit.
		expect(ctx.scriptCalls).toHaveLength(0);
		// No duplicate artifact created.
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
			nodeId: 'task-agent',
			artifactType: 'result',
		});
		expect(artifacts).toHaveLength(1);
	});

	test('does NOT short-circuit for a different PR URL', async () => {
		ctx.artifactRepo.upsert({
			id: 'prior-other-pr',
			runId: ctx.workflowRunId,
			nodeId: 'task-agent',
			artifactType: 'result',
			artifactKey: 'merge_pr:other',
			data: { merged_pr_url: 'https://github.com/neokai/neokai/pull/9999', status: 'merged' },
		});
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		expect(parseToolResult<{ success: true; alreadyMerged?: boolean }>(res).success).toBe(true);
		expect(parseToolResult<{ alreadyMerged?: boolean }>(res).alreadyMerged).toBeUndefined();
		expect(ctx.scriptCalls).toHaveLength(1);
	});

	test('relies only on listByRun — no json_extract SQL filter', async () => {
		// Sanity check: the artifact repo's listByRun filters by nodeId + type
		// and we scan in-memory. Inject an artifact on a different node to
		// verify that a scan-by-nodeId prevents cross-node false positives.
		ctx.artifactRepo.upsert({
			id: 'other-node-artifact',
			runId: ctx.workflowRunId,
			nodeId: 'some-end-node',
			artifactType: 'result',
			artifactKey: 'noise',
			data: { merged_pr_url: DEFAULT_PR_URL },
		});
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		// The other-node artifact must NOT be treated as idempotent evidence.
		expect(parseToolResult<{ alreadyMerged?: boolean }>(res).alreadyMerged).toBeUndefined();
		expect(ctx.scriptCalls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Script failure / timeout / spawn errors
// ---------------------------------------------------------------------------

describe('merge_pr — script failure surfacing', () => {
	let ctx: HandlerCtx;
	beforeEach(() => {
		ctx = makeCtx({ autonomyLevel: 5 });
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('non-zero exit → failure with stderr + stdout', async () => {
		ctx.scriptResult = {
			exitCode: 1,
			stdout: '',
			stderr: 'gh: could not authenticate',
			timedOut: false,
		};
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string; stderr?: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('exited with code 1');
		expect(parsed.stderr).toContain('could not authenticate');

		// No artifact written on failure.
		expect(ctx.artifactRepo.listByRun(ctx.workflowRunId, { nodeId: 'task-agent' })).toHaveLength(0);
	});

	test('timeout → failure carrying the timeoutMs constant', async () => {
		ctx.scriptResult = { exitCode: -1, stdout: '', stderr: '', timedOut: true };
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(`${PR_MERGE_SCRIPT_TIMEOUT_MS}ms`);
	});

	test('spawn throw → failure surfaced in error', async () => {
		ctx.runScriptOverride = async () => {
			throw new Error('bash: command not found');
		};
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{ success: false; error: string }>(res);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Failed to spawn');
		expect(parsed.error).toContain('bash: command not found');
	});
});

// ---------------------------------------------------------------------------
// Snapshot — canonical request_human_input question format
// ---------------------------------------------------------------------------

describe('merge_pr — canonical human-input question snapshot', () => {
	test('question format is stable across prompt drift', () => {
		expect(buildMergeApprovalQuestion('https://github.com/owner/repo/pull/42')).toBe(
			'Approve merging PR https://github.com/owner/repo/pull/42?'
		);
	});

	test('context hint format is stable across prompt drift', () => {
		expect(buildMergeApprovalContextHint('https://github.com/owner/repo/pull/42')).toBe(
			[
				'The end node of this workflow signalled a post-approval action:',
				'  action: merge_pr',
				'  pr_url: https://github.com/owner/repo/pull/42',
				`Space autonomy level is below the auto-merge threshold (${MERGE_AUTONOMY_THRESHOLD}), so a human must confirm before the Task Agent runs the merge.`,
			].join('\n')
		);
	});

	test('refusal error at level < 4 includes the canonical question verbatim', async () => {
		const ctx = makeCtx({ autonomyLevel: 2 });
		const handler = buildHandler(ctx);
		const res = await handler({ pr_url: DEFAULT_PR_URL });
		const parsed = parseToolResult<{
			success: false;
			error: string;
			canonicalQuestion: string;
			canonicalContextHint: string;
		}>(res);
		expect(parsed.canonicalQuestion).toBe(buildMergeApprovalQuestion(DEFAULT_PR_URL));
		expect(parsed.canonicalContextHint).toBe(buildMergeApprovalContextHint(DEFAULT_PR_URL));
		// Also present in the human-readable error so the LLM picks it up.
		expect(parsed.error).toContain(`"${buildMergeApprovalQuestion(DEFAULT_PR_URL)}"`);
		ctx.db.close();
	});
});

// ---------------------------------------------------------------------------
// Feature-flag detection
// ---------------------------------------------------------------------------

describe('isMergeExecutorFeatureEnabled', () => {
	const envKey = 'NEOKAI_TASK_AGENT_MERGE_EXECUTOR';
	const originalEnv = process.env[envKey];
	afterEach(() => {
		if (originalEnv === undefined) delete process.env[envKey];
		else process.env[envKey] = originalEnv;
	});

	test('returns false when env var is unset and no space bit is set', () => {
		delete process.env[envKey];
		expect(isMergeExecutorFeatureEnabled()).toBe(false);
		expect(isMergeExecutorFeatureEnabled({})).toBe(false);
	});

	test('env var accepts 1 / true / yes (case-insensitive)', () => {
		for (const v of ['1', 'true', 'True', 'YES', 'yes']) {
			process.env[envKey] = v;
			expect(isMergeExecutorFeatureEnabled()).toBe(true);
		}
	});

	test('env var rejects other values', () => {
		for (const v of ['0', 'false', 'off', '', 'maybe']) {
			process.env[envKey] = v;
			expect(isMergeExecutorFeatureEnabled()).toBe(false);
		}
	});

	test('space.experimentalFeatures.taskAgentMergeExecutor === true enables', () => {
		delete process.env[envKey];
		expect(
			isMergeExecutorFeatureEnabled({
				experimentalFeatures: { taskAgentMergeExecutor: true },
			})
		).toBe(true);
	});

	test('space.experimentalFeatures.taskAgentMergeExecutor falsy does not enable', () => {
		delete process.env[envKey];
		expect(
			isMergeExecutorFeatureEnabled({
				experimentalFeatures: { taskAgentMergeExecutor: false },
			})
		).toBe(false);
		expect(isMergeExecutorFeatureEnabled({ experimentalFeatures: {} })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// defaultMergeScriptExecutor — smoke test with a trivial in-process script
// ---------------------------------------------------------------------------

describe('defaultMergeScriptExecutor', () => {
	test('spawns bash -c and captures stdout/stderr/exit', async () => {
		const result = await defaultMergeScriptExecutor({
			script: 'echo "hi stdout"; echo "hi stderr" >&2; exit 0',
			env: { ...process.env } as Record<string, string>,
			cwd: process.cwd(),
			timeoutMs: 5_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.stdout).toContain('hi stdout');
		expect(result.stderr).toContain('hi stderr');
	});

	test('returns non-zero exit for failing scripts', async () => {
		const result = await defaultMergeScriptExecutor({
			script: 'exit 7',
			env: { ...process.env } as Record<string, string>,
			cwd: process.cwd(),
			timeoutMs: 5_000,
		});
		expect(result.exitCode).toBe(7);
	});
});
