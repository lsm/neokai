/**
 * Dead Loop Detector - Detects infinite bounce cycles in runtime gates
 *
 * When a gate repeatedly rejects an agent for the same reason, it is likely stuck
 * in an infinite loop. This detector tracks gate failures per group and flags
 * dead loops so the runtime can fail the task early with a diagnostic message.
 *
 * Detection strategy:
 * - Count-based: same gate fails >= maxFailures times within rapidFailureWindow
 * - Similarity-based: failure reasons are similar (avoids counting distinct issues)
 *
 * All detection logic is pure (no I/O), making it easy to test.
 */

export interface GateFailureRecord {
	/** Gate that failed (e.g., 'worker_exit', 'leader_complete', 'leader_submit') */
	gateName: string;
	/** Human-readable failure reason from the gate */
	reason: string;
	/** Unix timestamp (ms) when the failure occurred */
	timestamp: number;
}

export interface DeadLoopConfig {
	/** Max failures before detecting loop within the time window (default: 5) */
	maxFailures: number;
	/** Time window (ms) within which failures are considered "rapid" (default: 5 min) */
	rapidFailureWindow: number;
	/** Similarity threshold for reason matching — 0-1 (default: 0.75) */
	reasonSimilarityThreshold: number;
}

export interface DeadLoopStatus {
	isDeadLoop: boolean;
	/** Human-readable description of the detected loop */
	reason: string;
	/** Number of failures in the detection window */
	failureCount: number;
	/** Milliseconds spanned by the detected failures */
	timeWindowMs: number;
	/** Gate name that is looping */
	gateName: string;
	/** Top distinct failure reasons for diagnostic output */
	topFailureReasons: string[];
}

export const DEFAULT_DEAD_LOOP_CONFIG: DeadLoopConfig = {
	maxFailures: 5,
	rapidFailureWindow: 5 * 60 * 1000, // 5 minutes
	reasonSimilarityThreshold: 0.75,
};

// ---------------------------------------------------------------------------
// String similarity helpers (Levenshtein distance based)
// ---------------------------------------------------------------------------

/**
 * Normalize a string for similarity comparison.
 * Lowercase, strip punctuation, collapse whitespace.
 */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// Use a single row DP approach to save memory
	const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = i;
		for (let j = 1; j <= n; j++) {
			const curr = a[i - 1] === b[j - 1] ? dp[j - 1] : Math.min(dp[j - 1], dp[j], prev) + 1;
			dp[j - 1] = prev;
			prev = curr;
		}
		dp[n] = prev;
	}
	return dp[n];
}

/**
 * Compute normalized similarity score between two strings (0.0 – 1.0).
 * Returns 1.0 for identical strings, 0.0 for completely different strings.
 */
export function calculateSimilarity(a: string, b: string): number {
	const s1 = normalize(a);
	const s2 = normalize(b);
	if (s1 === s2) return 1;
	if (s1.length === 0 && s2.length === 0) return 1;
	if (s1.length === 0 || s2.length === 0) return 0;
	const maxLen = Math.max(s1.length, s2.length);
	const dist = editDistance(s1, s2);
	return (maxLen - dist) / maxLen;
}

// ---------------------------------------------------------------------------
// Dead loop detection
// ---------------------------------------------------------------------------

/**
 * Check whether a gate failure history constitutes a dead loop.
 *
 * Returns a DeadLoopStatus with isDeadLoop=true when the same gate has failed
 * at least `config.maxFailures` times within `config.rapidFailureWindow` AND
 * the failure reasons are sufficiently similar (or the count reaches 2×
 * the threshold regardless of similarity).
 *
 * Returns null when the history is too short to trigger detection, or when
 * the count threshold is met but the reasons are too distinct (different
 * underlying issues, not a stuck loop).
 */
export function checkDeadLoop(
	history: GateFailureRecord[],
	config: DeadLoopConfig = DEFAULT_DEAD_LOOP_CONFIG
): DeadLoopStatus | null {
	if (history.length === 0) return null;

	const now = Date.now();
	const windowStart = now - config.rapidFailureWindow;

	// Group recent failures by gate name
	const byGate = new Map<string, GateFailureRecord[]>();
	for (const record of history) {
		if (record.timestamp >= windowStart) {
			const list = byGate.get(record.gateName) ?? [];
			list.push(record);
			byGate.set(record.gateName, list);
		}
	}

	for (const [gateName, records] of byGate) {
		if (records.length < config.maxFailures) continue;

		// Check how similar the failure reasons are to each other
		const reasons = records.map((r) => r.reason);
		let similarPairs = 0;
		let totalPairs = 0;

		for (let i = 0; i < reasons.length - 1; i++) {
			for (let j = i + 1; j < reasons.length; j++) {
				totalPairs++;
				if (calculateSimilarity(reasons[i], reasons[j]) >= config.reasonSimilarityThreshold) {
					similarPairs++;
				}
			}
		}

		// Similarity ratio of pairs: if most pairs are similar, reasons are repetitive
		const similarityRatio = totalPairs > 0 ? similarPairs / totalPairs : 0;

		// It's a dead loop if reasons are mostly similar (repetitive failure)
		// OR if the count is very high (>= 2x threshold), regardless of similarity —
		// the agent clearly cannot make progress
		const isRepetitive = similarityRatio >= 0.5;
		const isExcessiveCount = records.length >= config.maxFailures * 2;

		if (isRepetitive || isExcessiveCount) {
			const timeWindowMs = records[records.length - 1].timestamp - records[0].timestamp;
			const topFailureReasons = [...new Set(reasons)].slice(0, 3);

			return {
				isDeadLoop: true,
				reason: `Gate "${gateName}" failed ${records.length} times${timeWindowMs > 0 ? ` over ${Math.round(timeWindowMs / 1000)}s` : ''} with similar reasons`,
				failureCount: records.length,
				timeWindowMs,
				gateName,
				topFailureReasons,
			};
		}
	}

	return null;
}
