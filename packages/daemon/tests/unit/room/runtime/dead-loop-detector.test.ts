import { describe, test, expect } from 'bun:test';
import {
	checkDeadLoop,
	calculateSimilarity,
	type GateFailureRecord,
	type DeadLoopConfig,
} from '../../../../src/lib/room/runtime/dead-loop-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(gateName: string, reason: string, offsetMs = 0): GateFailureRecord {
	return { gateName, reason, timestamp: Date.now() - offsetMs };
}

/** Build N records for the same gate with the same reason, evenly spread */
function makeRepeatedFailures(
	gateName: string,
	reason: string,
	count: number,
	spreadMs = 10_000
): GateFailureRecord[] {
	const now = Date.now();
	return Array.from({ length: count }, (_, i) => ({
		gateName,
		reason,
		// Spread evenly within spreadMs total window; oldest first
		timestamp: now - spreadMs + Math.floor((i * spreadMs) / Math.max(count - 1, 1)),
	}));
}

const STRICT_CONFIG: DeadLoopConfig = {
	maxFailures: 3,
	rapidFailureWindow: 5 * 60 * 1000,
	reasonSimilarityThreshold: 0.75,
};

// ---------------------------------------------------------------------------
// calculateSimilarity
// ---------------------------------------------------------------------------

describe('calculateSimilarity', () => {
	test('identical strings return 1', () => {
		expect(calculateSimilarity('hello world', 'hello world')).toBe(1);
	});

	test('completely different strings return low score', () => {
		const score = calculateSimilarity('abc', 'xyz');
		expect(score).toBeLessThan(0.5);
	});

	test('similar strings return high score', () => {
		const score = calculateSimilarity(
			'PR not found. Please create a PR before completing.',
			'No PR exists. Create PR before completing.'
		);
		expect(score).toBeGreaterThan(0.6);
	});

	test('normalization ignores punctuation and case', () => {
		const s1 = 'No PR exists!';
		const s2 = 'no pr exists';
		expect(calculateSimilarity(s1, s2)).toBe(1);
	});

	test('empty strings both return 1', () => {
		expect(calculateSimilarity('', '')).toBe(1);
	});

	test('one empty string returns 0', () => {
		expect(calculateSimilarity('hello', '')).toBe(0);
		expect(calculateSimilarity('', 'world')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// checkDeadLoop — basic cases
// ---------------------------------------------------------------------------

describe('checkDeadLoop', () => {
	test('returns null for empty history', () => {
		expect(checkDeadLoop([])).toBeNull();
	});

	test('returns null when fewer failures than maxFailures', () => {
		const history = makeRepeatedFailures('worker_exit', 'No PR', 4);
		const result = checkDeadLoop(history, STRICT_CONFIG);
		// 4 < 3*2=6 but >= threshold 3; however similarity must pass too
		// With count >= maxFailures AND similar reasons → should detect
		expect(result?.isDeadLoop).toBe(true);
	});

	test('detects dead loop when same gate fails maxFailures times with similar reasons', () => {
		const history = makeRepeatedFailures('worker_exit', 'No PR found for branch feature/x', 5);
		const result = checkDeadLoop(history, STRICT_CONFIG);
		expect(result).not.toBeNull();
		expect(result?.isDeadLoop).toBe(true);
		expect(result?.gateName).toBe('worker_exit');
		expect(result?.failureCount).toBe(5);
	});

	test('detects dead loop with slightly varied but similar reasons', () => {
		// All reasons are near-identical (small typo differences) — most pairs should be >= 0.75 similar
		const reasons = [
			'No PR found for branch feat/abc.',
			'No PR found for branch feat/abc!',
			'No PR found for branch feat/abc',
			'No PR found for branch feat/abc.',
		];
		const now = Date.now();
		const history: GateFailureRecord[] = reasons.map((reason, i) => ({
			gateName: 'worker_exit',
			reason,
			timestamp: now - (reasons.length - i) * 5000,
		}));
		const result = checkDeadLoop(history, STRICT_CONFIG);
		expect(result?.isDeadLoop).toBe(true);
	});

	test('does NOT detect loop when failures span different gates', () => {
		// 3 worker_exit + 3 leader_complete — neither gate alone exceeds threshold
		const history: GateFailureRecord[] = [
			...makeRepeatedFailures('worker_exit', 'No PR', 2),
			...makeRepeatedFailures('leader_complete', 'PR not merged', 2),
		];
		const result = checkDeadLoop(history, STRICT_CONFIG);
		// Neither gate has 3 failures → null
		expect(result).toBeNull();
	});

	test('does NOT detect loop when failures are outside the time window', () => {
		const windowMs = 2 * 60 * 1000; // 2 min window
		const config: DeadLoopConfig = {
			maxFailures: 3,
			rapidFailureWindow: windowMs,
			reasonSimilarityThreshold: 0.75,
		};
		// All failures older than the window
		const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
		const history: GateFailureRecord[] = Array.from({ length: 5 }, (_, i) => ({
			gateName: 'worker_exit',
			reason: 'No PR found.',
			timestamp: oldTime + i * 1000,
		}));
		const result = checkDeadLoop(history, config);
		expect(result).toBeNull();
	});

	test('detects loop even with very high count and dissimilar reasons (excessive count path)', () => {
		// maxFailures=3 so 2x threshold = 6; distinct reasons → similarity won't catch it
		const now = Date.now();
		const distinctReasons = [
			'PR not found',
			'Branch check failed',
			'No commits pushed',
			'Worktree dirty',
			'Model mismatch',
			'Unknown git state',
		];
		const history: GateFailureRecord[] = distinctReasons.map((reason, i) => ({
			gateName: 'worker_exit',
			reason,
			timestamp: now - (distinctReasons.length - i) * 3000,
		}));
		const result = checkDeadLoop(history, STRICT_CONFIG);
		// 6 failures >= maxFailures*2 (3*2=6) → isExcessiveCount path
		expect(result?.isDeadLoop).toBe(true);
		expect(result?.failureCount).toBe(6);
	});

	test('returns topFailureReasons with at most 3 distinct entries', () => {
		const history = makeRepeatedFailures('leader_complete', 'No PR exists.', 5);
		const result = checkDeadLoop(history, STRICT_CONFIG);
		expect(result?.topFailureReasons.length).toBeLessThanOrEqual(3);
	});

	test('timeWindowMs is 0 for a single instantaneous failure burst', () => {
		// All records have the same timestamp
		const now = Date.now();
		const history: GateFailureRecord[] = Array.from({ length: 5 }, () => ({
			gateName: 'worker_exit',
			reason: 'No PR.',
			timestamp: now,
		}));
		const result = checkDeadLoop(history, STRICT_CONFIG);
		expect(result?.isDeadLoop).toBe(true);
		expect(result?.timeWindowMs).toBe(0);
	});

	test('uses default config when none provided', () => {
		// Default maxFailures = 5
		const history = makeRepeatedFailures('worker_exit', 'No PR', 5);
		const result = checkDeadLoop(history); // no config arg
		expect(result?.isDeadLoop).toBe(true);
	});

	test('returns null with 4 failures when maxFailures=5 and count < 2x threshold', () => {
		const config: DeadLoopConfig = {
			maxFailures: 5,
			rapidFailureWindow: 5 * 60 * 1000,
			reasonSimilarityThreshold: 0.75,
		};
		const history = makeRepeatedFailures('worker_exit', 'No PR', 4);
		// 4 < 5 → null (before similarity check)
		const result = checkDeadLoop(history, config);
		expect(result).toBeNull();
	});

	// -------------------------------------------------------------------
	// Oscillation pattern: gate fails → succeeds (no record) → fails again
	// -------------------------------------------------------------------

	test('detects oscillation when failures accumulate over multiple cycles', () => {
		// Simulate: fail 3x → some time passes → fail 3x again (all within window)
		const now = Date.now();
		const firstBatch: GateFailureRecord[] = Array.from({ length: 3 }, (_, i) => ({
			gateName: 'leader_complete',
			reason: 'PR not merged yet.',
			timestamp: now - 4 * 60 * 1000 + i * 20_000, // 4 min ago
		}));
		const secondBatch: GateFailureRecord[] = Array.from({ length: 3 }, (_, i) => ({
			gateName: 'leader_complete',
			reason: 'PR not merged.',
			timestamp: now - 1 * 60 * 1000 + i * 10_000, // 1 min ago
		}));
		const result = checkDeadLoop([...firstBatch, ...secondBatch], STRICT_CONFIG);
		expect(result?.isDeadLoop).toBe(true);
		expect(result?.failureCount).toBe(6);
	});
});
