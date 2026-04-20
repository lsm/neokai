/**
 * Unit tests for completion-action-executors.ts
 *
 * Exercises the runtime-injectable executor helpers directly — no DB,
 * no SpaceRuntime, no agent SDK. These helpers are the low-level
 * building blocks the runtime composes for `instruction` and `mcp_call`
 * completion actions:
 *
 *   - `accessByPath(root, path)` — dot/bracket accessor into a JSON-ish value
 *   - `evaluateMcpExpectation(result, expectation)` — typed assertion check
 *   - `runMcpCallAction(action, ctx, executor)` — tool-call + assertion wrapper
 *
 * Keeping these tests at the helper level lets the SpaceRuntime integration
 * tests focus on orchestration (dispatch, pause/resume, notification emission)
 * while we validate the assertion semantics once, in isolation.
 */

import { describe, test, expect } from 'bun:test';
import {
	accessByPath,
	evaluateMcpExpectation,
	runMcpCallAction,
	type McpToolExecutor,
} from '../../../../src/lib/space/runtime/completion-action-executors';
import type { McpCallCompletionAction, McpCallExpectation } from '@neokai/shared';

// ---------------------------------------------------------------------------
// accessByPath
// ---------------------------------------------------------------------------

describe('accessByPath', () => {
	test('empty path returns the root value', () => {
		expect(accessByPath({ a: 1 }, '')).toEqual({ a: 1 });
		expect(accessByPath('hello', '')).toBe('hello');
		expect(accessByPath(null, '')).toBe(null);
	});

	test('dot access resolves nested object fields', () => {
		const root = { data: { items: { status: 'OK' } } };
		expect(accessByPath(root, 'data.items.status')).toBe('OK');
		expect(accessByPath(root, 'data')).toEqual({ items: { status: 'OK' } });
	});

	test('bracket-index access resolves array elements', () => {
		const root = { data: { items: [{ id: 'a' }, { id: 'b' }] } };
		expect(accessByPath(root, 'data.items[0]')).toEqual({ id: 'a' });
		expect(accessByPath(root, 'data.items[1].id')).toBe('b');
	});

	test('bracket-string access supports quoted keys with spaces', () => {
		const root = { data: { 'weird key': 42 } };
		expect(accessByPath(root, "data['weird key']")).toBe(42);
		expect(accessByPath(root, 'data["weird key"]')).toBe(42);
	});

	test('missing segment yields undefined instead of throwing', () => {
		const root = { a: { b: 1 } };
		expect(accessByPath(root, 'a.c')).toBeUndefined();
		expect(accessByPath(root, 'a.b.c')).toBeUndefined();
		expect(accessByPath(root, 'x.y.z')).toBeUndefined();
	});

	test('out-of-range array index yields undefined', () => {
		const root = { arr: [1, 2, 3] };
		expect(accessByPath(root, 'arr[5]')).toBeUndefined();
	});

	test('primitive cursor with further segments yields undefined', () => {
		// Once we hit a primitive (string/number), further nav can't descend.
		expect(accessByPath({ a: 'str' }, 'a.b')).toBeUndefined();
		expect(accessByPath({ a: 42 }, 'a.b')).toBeUndefined();
	});

	test('null/undefined anywhere short-circuits to undefined', () => {
		const root = { a: null, b: undefined };
		expect(accessByPath(root, 'a.x')).toBeUndefined();
		expect(accessByPath(root, 'b.x')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// evaluateMcpExpectation
// ---------------------------------------------------------------------------

describe('evaluateMcpExpectation', () => {
	test('exists: success when path resolves, failure when undefined', () => {
		const result = { state: 'MERGED', count: 0 };
		expect(evaluateMcpExpectation(result, { path: 'state', op: 'exists' })).toEqual({
			success: true,
		});
		// `0` exists (not undefined)
		expect(evaluateMcpExpectation(result, { path: 'count', op: 'exists' })).toEqual({
			success: true,
		});
		const res = evaluateMcpExpectation(result, { path: 'missing', op: 'exists' });
		expect(res.success).toBe(false);
		expect(res.reason).toContain('missing');
		expect(res.reason).toContain('undefined');
	});

	test('truthy: success for truthy, failure for falsy with reason', () => {
		expect(evaluateMcpExpectation({ ok: true }, { path: 'ok', op: 'truthy' })).toEqual({
			success: true,
		});
		expect(evaluateMcpExpectation({ ok: 'yes' }, { path: 'ok', op: 'truthy' })).toEqual({
			success: true,
		});
		const zero = evaluateMcpExpectation({ n: 0 }, { path: 'n', op: 'truthy' });
		expect(zero.success).toBe(false);
		expect(zero.reason).toContain('truthy');
		const falseRes = evaluateMcpExpectation({ ok: false }, { path: 'ok', op: 'truthy' });
		expect(falseRes.success).toBe(false);
	});

	test('eq: deep equality succeeds, mismatch yields descriptive reason', () => {
		const exp: McpCallExpectation = { path: 'state', op: 'eq', value: 'MERGED' };
		expect(evaluateMcpExpectation({ state: 'MERGED' }, exp)).toEqual({ success: true });

		const bad = evaluateMcpExpectation({ state: 'OPEN' }, exp);
		expect(bad.success).toBe(false);
		expect(bad.reason).toContain('"state"');
		expect(bad.reason).toContain('"MERGED"');
		expect(bad.reason).toContain('"OPEN"');
	});

	test('eq: deep equality across nested structures', () => {
		const exp: McpCallExpectation = {
			path: 'data',
			op: 'eq',
			value: { items: [1, 2], meta: { ok: true } },
		};
		expect(evaluateMcpExpectation({ data: { items: [1, 2], meta: { ok: true } } }, exp)).toEqual({
			success: true,
		});
		expect(
			evaluateMcpExpectation({ data: { items: [1, 2], meta: { ok: false } } }, exp).success
		).toBe(false);
	});

	test('neq: succeeds when values differ, fails when equal', () => {
		const exp: McpCallExpectation = { path: 'state', op: 'neq', value: 'OPEN' };
		expect(evaluateMcpExpectation({ state: 'MERGED' }, exp)).toEqual({ success: true });

		const bad = evaluateMcpExpectation({ state: 'OPEN' }, exp);
		expect(bad.success).toBe(false);
		expect(bad.reason).toContain('not to equal');
	});

	test('contains: substring match for strings', () => {
		const exp: McpCallExpectation = { path: 'msg', op: 'contains', value: 'merged' };
		expect(evaluateMcpExpectation({ msg: 'PR was merged yesterday' }, exp)).toEqual({
			success: true,
		});
		expect(evaluateMcpExpectation({ msg: 'PR open' }, exp).success).toBe(false);
	});

	test('contains: element membership for arrays (deep equality)', () => {
		const exp: McpCallExpectation = { path: 'tags', op: 'contains', value: { name: 'bug' } };
		expect(evaluateMcpExpectation({ tags: [{ name: 'docs' }, { name: 'bug' }] }, exp)).toEqual({
			success: true,
		});
		expect(evaluateMcpExpectation({ tags: [{ name: 'docs' }] }, exp).success).toBe(false);
	});

	test('contains: non-string/non-array container yields failure', () => {
		const exp: McpCallExpectation = { path: 'data', op: 'contains', value: 'x' };
		expect(evaluateMcpExpectation({ data: 42 }, exp).success).toBe(false);
		expect(evaluateMcpExpectation({ data: { x: 1 } }, exp).success).toBe(false);
	});

	test('unknown op surfaces as failure (defensive; type system should block)', () => {
		// Force an invalid op past the type guard to exercise the default branch.
		const bogus = { path: 'x', op: 'nope' as unknown as McpCallExpectation['op'] };
		const res = evaluateMcpExpectation({ x: 1 }, bogus);
		expect(res.success).toBe(false);
		expect(res.reason).toContain('unknown');
	});
});

// ---------------------------------------------------------------------------
// runMcpCallAction
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<McpCallCompletionAction> = {}): McpCallCompletionAction {
	return {
		id: 'a1',
		name: 'Check PR merged',
		type: 'mcp_call',
		requiredLevel: 2,
		server: 'github',
		tool: 'pr_status',
		args: { prUrl: 'https://github.com/x/y/pull/1' },
		...overrides,
	};
}

const CTX = {
	spaceId: 'space-1',
	runId: 'run-1',
	workspacePath: '/tmp',
	artifactData: {},
};

describe('runMcpCallAction', () => {
	test('no expect + non-throwing executor → success', async () => {
		const executor: McpToolExecutor = async () => ({ state: 'MERGED' });
		const result = await runMcpCallAction(makeAction(), CTX, executor);
		expect(result).toEqual({ success: true });
	});

	test('executor throws → failure carrying the error message', async () => {
		const executor: McpToolExecutor = async () => {
			throw new Error('connection refused');
		};
		const result = await runMcpCallAction(makeAction(), CTX, executor);
		expect(result.success).toBe(false);
		expect(result.reason).toContain('pr_status');
		expect(result.reason).toContain('connection refused');
	});

	test('executor throws non-Error → failure with stringified value', async () => {
		const executor: McpToolExecutor = async () => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw 'string-error'; // non-Error throw
		};
		const result = await runMcpCallAction(makeAction(), CTX, executor);
		expect(result.success).toBe(false);
		expect(result.reason).toContain('string-error');
	});

	test('with passing expect → success', async () => {
		const executor: McpToolExecutor = async () => ({ state: 'MERGED' });
		const action = makeAction({
			expect: { path: 'state', op: 'eq', value: 'MERGED' },
		});
		const result = await runMcpCallAction(action, CTX, executor);
		expect(result).toEqual({ success: true });
	});

	test('with failing expect → failure with descriptive reason', async () => {
		const executor: McpToolExecutor = async () => ({ state: 'OPEN' });
		const action = makeAction({
			expect: { path: 'state', op: 'eq', value: 'MERGED' },
		});
		const result = await runMcpCallAction(action, CTX, executor);
		expect(result.success).toBe(false);
		expect(result.reason).toContain('"OPEN"');
		expect(result.reason).toContain('"MERGED"');
	});

	test('executor receives the action and ctx verbatim', async () => {
		const calls: Array<{ action: McpCallCompletionAction; ctx: typeof CTX }> = [];
		const executor: McpToolExecutor = async (action, ctx) => {
			calls.push({ action, ctx: ctx as typeof CTX });
			return {};
		};
		const action = makeAction({ args: { prUrl: 'u', state: 'MERGED' } });
		await runMcpCallAction(action, CTX, executor);
		expect(calls).toHaveLength(1);
		expect(calls[0].action).toBe(action);
		expect(calls[0].ctx).toBe(CTX);
	});
});
