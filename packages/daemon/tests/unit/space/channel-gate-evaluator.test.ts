/**
 * ChannelGateEvaluator Unit Tests
 *
 * Covers all 4 gate types:
 *   always      — always allows delivery
 *   human       — blocks until humanApproved === true
 *   condition   — shell expression; allowed on exit code 0
 *   task_result — prefix match on taskResult string
 *
 * Also covers:
 *   - No gate field → always allowed
 *   - Empty expression → blocked with clear message
 *   - Command execution error → blocked with error message
 *   - Timeout → blocked with timeout message
 *   - ChannelGateBlockedError construction and properties
 */

import { describe, test, expect } from 'bun:test';
import {
	ChannelGateEvaluator,
	ChannelGateBlockedError,
} from '../../../src/lib/space/runtime/channel-gate-evaluator.ts';
import type {
	ChannelCommandRunner,
	ChannelGateContext,
} from '../../../src/lib/space/runtime/channel-gate-evaluator.ts';
import type { WorkflowChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<WorkflowChannel> = {}): WorkflowChannel {
	return {
		from: 'agent-a',
		to: 'agent-b',
		direction: 'one-way',
		...overrides,
	};
}

function makeContext(overrides: Partial<ChannelGateContext> = {}): ChannelGateContext {
	return {
		workspacePath: '/tmp/test-workspace',
		...overrides,
	};
}

function makeOkRunner(): ChannelCommandRunner {
	return async () => ({ exitCode: 0 });
}

function makeFailRunner(exitCode = 1, stderr = ''): ChannelCommandRunner {
	return async () => ({ exitCode, stderr });
}

function makeTimeoutRunner(): ChannelCommandRunner {
	return async () => ({ exitCode: null, timedOut: true });
}

function makeThrowRunner(message: string): ChannelCommandRunner {
	return async () => {
		throw new Error(message);
	};
}

/** Returns a runner that records the timeoutMs argument it was called with. */
function makeCapturingRunner(): { runner: ChannelCommandRunner; getTimeout: () => number } {
	let capturedTimeout = -1;
	return {
		runner: async (_args, _cwd, timeoutMs) => {
			capturedTimeout = timeoutMs;
			return { exitCode: 0 };
		},
		getTimeout: () => capturedTimeout,
	};
}

// ---------------------------------------------------------------------------
// Tests: no gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — no gate', () => {
	test('channel without gate is always allowed', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluate(makeChannel(), makeContext());
		expect(result.allowed).toBe(true);
		expect(result.reason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: always gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — always gate', () => {
	test('always gate allows delivery unconditionally', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'always' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(true);
	});

	test('always gate allows delivery even with no humanApproved', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'always' } });
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: false }));
		expect(result.allowed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: human gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — human gate', () => {
	test('human gate blocks when humanApproved is absent', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'human' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('human approval');
	});

	test('human gate blocks when humanApproved is false', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'human' } });
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: false }));
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('human approval');
	});

	test('human gate allows delivery when humanApproved is true', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'human' } });
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: true }));
		expect(result.allowed).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test('human gate reason contains "Gate blocked" prefix', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'human' } });
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: false }));
		expect(result.reason).toMatch(/^Gate blocked:/);
	});
});

// ---------------------------------------------------------------------------
// Tests: condition gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — condition gate', () => {
	test('condition gate allows delivery when command exits with code 0', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const channel = makeChannel({ gate: { type: 'condition', expression: 'true' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(true);
	});

	test('condition gate blocks when command exits with non-zero code', async () => {
		const evaluator = new ChannelGateEvaluator(makeFailRunner(1));
		const channel = makeChannel({ gate: { type: 'condition', expression: 'false' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('exit');
	});

	test('condition gate blocks when command exits with non-zero and includes stderr', async () => {
		const evaluator = new ChannelGateEvaluator(makeFailRunner(2, 'some error output'));
		const channel = makeChannel({ gate: { type: 'condition', expression: 'bad-cmd' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('some error output');
	});

	test('condition gate blocks on empty expression', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const channel = makeChannel({ gate: { type: 'condition', expression: '' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('non-empty expression');
	});

	test('condition gate blocks on whitespace-only expression', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const channel = makeChannel({ gate: { type: 'condition', expression: '   ' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('non-empty expression');
	});

	test('condition gate blocks on missing expression', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const channel = makeChannel({ gate: { type: 'condition' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('non-empty expression');
	});

	test('condition gate blocks when command runner throws', async () => {
		const evaluator = new ChannelGateEvaluator(makeThrowRunner('spawn failed'));
		const channel = makeChannel({ gate: { type: 'condition', expression: 'test -f /some/path' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('spawn failed');
	});

	test('condition gate blocks on timeout', async () => {
		const evaluator = new ChannelGateEvaluator(makeTimeoutRunner());
		const channel = makeChannel({ gate: { type: 'condition', expression: 'sleep 999' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('timed out');
	});

	test('condition gate reason contains "Gate blocked" prefix on failure', async () => {
		const evaluator = new ChannelGateEvaluator(makeFailRunner());
		const channel = makeChannel({ gate: { type: 'condition', expression: 'false' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.reason).toMatch(/^Gate blocked:/);
	});
});

// ---------------------------------------------------------------------------
// Tests: task_result gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — task_result gate', () => {
	test('task_result gate allows delivery on exact match', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: 'passed' } });
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'passed' }));
		expect(result.allowed).toBe(true);
	});

	test('task_result gate allows delivery on prefix match', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: 'pass' } });
		const result = await evaluator.evaluate(
			channel,
			makeContext({ taskResult: 'passed with details' })
		);
		expect(result.allowed).toBe(true);
	});

	test('task_result gate blocks when result does not match', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: 'passed' } });
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'failed' }));
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('"failed"');
		expect(result.reason).toContain('"passed"');
	});

	test('task_result gate blocks when taskResult is undefined', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: 'passed' } });
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('no task result available');
	});

	test('task_result gate blocks on empty expression', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: '' } });
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'passed' }));
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('non-empty expression');
	});

	test('task_result gate blocks on missing expression', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result' } });
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'passed' }));
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('non-empty expression');
	});

	test('task_result gate reason contains "Gate blocked" prefix on failure', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'task_result', expression: 'passed' } });
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'failed' }));
		expect(result.reason).toMatch(/^Gate blocked:/);
	});
});

// ---------------------------------------------------------------------------
// Tests: evaluateCondition (public method, direct access)
//
// These tests intentionally exercise evaluateCondition() as a public API
// contract — callers can evaluate conditions outside of a channel (e.g.
// testing individual gate expressions in isolation).  The condition/task_result
// cases intentionally overlap with the evaluate() tests above to confirm the
// public method returns the same results regardless of call path.
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator.evaluateCondition', () => {
	test('evaluates always condition directly', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluateCondition({ type: 'always' }, makeContext());
		expect(result.allowed).toBe(true);
	});

	test('evaluates human condition directly — blocked', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluateCondition(
			{ type: 'human' },
			makeContext({ humanApproved: false })
		);
		expect(result.allowed).toBe(false);
	});

	test('evaluates human condition directly — allowed', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluateCondition(
			{ type: 'human' },
			makeContext({ humanApproved: true })
		);
		expect(result.allowed).toBe(true);
	});

	// These confirm evaluateCondition() returns the same result as evaluate()
	// for condition/task_result, verifying the public API is a faithful delegate.
	test('evaluates condition gate directly — allowed on exit 0', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const result = await evaluator.evaluateCondition(
			{ type: 'condition', expression: 'echo ok' },
			makeContext()
		);
		expect(result.allowed).toBe(true);
	});

	test('evaluates condition gate directly — blocked on non-zero exit', async () => {
		const evaluator = new ChannelGateEvaluator(makeFailRunner(1));
		const result = await evaluator.evaluateCondition(
			{ type: 'condition', expression: 'false' },
			makeContext()
		);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/^Gate blocked:/);
	});

	test('evaluates task_result gate directly — allowed on prefix match', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluateCondition(
			{ type: 'task_result', expression: 'ci_passed' },
			makeContext({ taskResult: 'ci_passed: all 42 checks green' })
		);
		expect(result.allowed).toBe(true);
	});

	test('evaluates task_result gate directly — blocked on mismatch', async () => {
		const evaluator = new ChannelGateEvaluator();
		const result = await evaluator.evaluateCondition(
			{ type: 'task_result', expression: 'ci_passed' },
			makeContext({ taskResult: 'ci_failed' })
		);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/^Gate blocked:/);
	});
});

// ---------------------------------------------------------------------------
// Tests: condition gate timeoutMs propagation
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — condition gate timeoutMs', () => {
	test('default timeout (60 000 ms) is used when no timeoutMs specified', async () => {
		const { runner, getTimeout } = makeCapturingRunner();
		const evaluator = new ChannelGateEvaluator(runner);
		await evaluator.evaluate(
			makeChannel({ gate: { type: 'condition', expression: 'true' } }),
			makeContext()
		);
		expect(getTimeout()).toBe(60_000);
	});

	test('custom timeoutMs within valid range is passed to the command runner', async () => {
		const { runner, getTimeout } = makeCapturingRunner();
		const evaluator = new ChannelGateEvaluator(runner);
		await evaluator.evaluate(
			makeChannel({ gate: { type: 'condition', expression: 'true', timeoutMs: 5_000 } }),
			makeContext()
		);
		expect(getTimeout()).toBe(5_000);
	});

	test('timeoutMs above 300 000 ms is clamped to 300 000', async () => {
		const { runner, getTimeout } = makeCapturingRunner();
		const evaluator = new ChannelGateEvaluator(runner);
		await evaluator.evaluate(
			makeChannel({ gate: { type: 'condition', expression: 'true', timeoutMs: 999_999 } }),
			makeContext()
		);
		expect(getTimeout()).toBe(300_000);
	});

	test('timeoutMs of 0 falls back to default 60 000 ms', async () => {
		const { runner, getTimeout } = makeCapturingRunner();
		const evaluator = new ChannelGateEvaluator(runner);
		await evaluator.evaluate(
			makeChannel({ gate: { type: 'condition', expression: 'true', timeoutMs: 0 } }),
			makeContext()
		);
		expect(getTimeout()).toBe(60_000);
	});

	test('negative timeoutMs falls back to default 60 000 ms', async () => {
		const { runner, getTimeout } = makeCapturingRunner();
		const evaluator = new ChannelGateEvaluator(runner);
		await evaluator.evaluate(
			makeChannel({ gate: { type: 'condition', expression: 'true', timeoutMs: -100 } }),
			makeContext()
		);
		expect(getTimeout()).toBe(60_000);
	});
});

// ---------------------------------------------------------------------------
// Tests: ChannelGateBlockedError
// ---------------------------------------------------------------------------

describe('ChannelGateBlockedError', () => {
	test('has correct name', () => {
		const err = new ChannelGateBlockedError('delivery blocked', 'human');
		expect(err.name).toBe('ChannelGateBlockedError');
	});

	test('stores gateType', () => {
		const err = new ChannelGateBlockedError('blocked by condition', 'condition');
		expect(err.gateType).toBe('condition');
	});

	test('is an instance of Error', () => {
		const err = new ChannelGateBlockedError('msg', 'always');
		expect(err).toBeInstanceOf(Error);
	});

	test('message is accessible', () => {
		const err = new ChannelGateBlockedError('gate is blocked', 'task_result');
		expect(err.message).toBe('gate is blocked');
	});

	test('can be thrown and caught', () => {
		expect(() => {
			throw new ChannelGateBlockedError('blocked', 'human');
		}).toThrow(ChannelGateBlockedError);
	});

	test('can be caught as Error', () => {
		expect(() => {
			throw new ChannelGateBlockedError('blocked', 'human');
		}).toThrow(Error);
	});

	test('caller pattern: throw on blocked delivery', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel = makeChannel({ gate: { type: 'human' } });
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: false }));

		const tryDeliver = () => {
			if (!result.allowed) {
				throw new ChannelGateBlockedError(result.reason!, channel.gate!.type);
			}
		};

		expect(tryDeliver).toThrow(ChannelGateBlockedError);
	});
});

// ---------------------------------------------------------------------------
// Tests: bidirectional channel with gate
// ---------------------------------------------------------------------------

describe('ChannelGateEvaluator — channel variants', () => {
	test('bidirectional channel with always gate is allowed', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel: WorkflowChannel = {
			from: 'coder',
			to: 'reviewer',
			direction: 'bidirectional',
			gate: { type: 'always' },
		};
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(true);
	});

	test('fan-out channel (array to) with human gate blocks correctly', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel: WorkflowChannel = {
			from: 'leader',
			to: ['worker-a', 'worker-b', 'worker-c'],
			direction: 'one-way',
			gate: { type: 'human' },
		};
		const result = await evaluator.evaluate(channel, makeContext({ humanApproved: false }));
		expect(result.allowed).toBe(false);
	});

	test('channel with isCyclic and task_result gate evaluates correctly', async () => {
		const evaluator = new ChannelGateEvaluator();
		const channel: WorkflowChannel = {
			from: 'coder',
			to: 'reviewer',
			direction: 'one-way',
			isCyclic: true,
			gate: { type: 'task_result', expression: 'ci_passed' },
		};
		const result = await evaluator.evaluate(channel, makeContext({ taskResult: 'ci_passed' }));
		expect(result.allowed).toBe(true);
	});

	test('channel with label and condition gate passes through correctly', async () => {
		const evaluator = new ChannelGateEvaluator(makeOkRunner());
		const channel: WorkflowChannel = {
			from: 'coder',
			to: 'reviewer',
			direction: 'one-way',
			label: 'Submit for review',
			gate: { type: 'condition', expression: 'test -f pr.md' },
		};
		const result = await evaluator.evaluate(channel, makeContext());
		expect(result.allowed).toBe(true);
	});
});
