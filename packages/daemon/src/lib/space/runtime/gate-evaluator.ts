/**
 * GateEvaluator — evaluates GateCondition trees against gate data.
 *
 * This evaluator works with the new separated Gate/Channel system (M1.1).
 * It reads gate data from the data store and evaluates the gate's condition
 * tree to determine whether the gate is open or closed.
 *
 * Condition types:
 *   check — field equality: data[field] === value
 *   count — numeric threshold: data[field] >= threshold
 *   all   — composite AND: all sub-conditions must pass (short-circuits on failure)
 *   any   — composite OR: at least one sub-condition must pass (short-circuits on success)
 */

import type { Gate, GateCondition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of evaluating a gate condition. */
export interface GateEvalResult {
	/** Whether the gate is open (condition passed). */
	open: boolean;
	/** Human-readable explanation when the gate is closed. */
	reason?: string;
}

// ---------------------------------------------------------------------------
// GateEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates a Gate's condition tree against the current gate data.
 *
 * Stateless — all data is passed in. No I/O or side effects.
 */
export function evaluateGate(gate: Gate, data: Record<string, unknown>): GateEvalResult {
	return evaluateCondition(gate.condition, data);
}

/**
 * Evaluates a single GateCondition node against the provided data.
 * Recursive for composite conditions (`all`, `any`).
 */
export function evaluateCondition(
	condition: GateCondition,
	data: Record<string, unknown>
): GateEvalResult {
	switch (condition.type) {
		case 'check':
			return evaluateCheck(condition.field, condition.value, data);

		case 'count':
			return evaluateCount(condition.field, condition.threshold, data);

		case 'all': {
			for (const sub of condition.conditions) {
				const result = evaluateCondition(sub, data);
				if (!result.open) return result;
			}
			return { open: true };
		}

		case 'any': {
			const reasons: string[] = [];
			for (const sub of condition.conditions) {
				const result = evaluateCondition(sub, data);
				if (result.open) return { open: true };
				if (result.reason) reasons.push(result.reason);
			}
			return {
				open: false,
				reason: `None of the conditions passed: [${reasons.join('; ')}]`,
			};
		}

		default: {
			const _exhaustive: never = condition;
			return {
				open: false,
				reason: `Unknown condition type: ${(_exhaustive as GateCondition).type}`,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Primitive evaluators
// ---------------------------------------------------------------------------

function evaluateCheck(
	field: string,
	expected: unknown,
	data: Record<string, unknown>
): GateEvalResult {
	const actual = data[field];
	if (actual === expected) {
		return { open: true };
	}
	return {
		open: false,
		reason: `Gate check failed: data["${field}"] is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
	};
}

function evaluateCount(
	field: string,
	threshold: number,
	data: Record<string, unknown>
): GateEvalResult {
	const raw = data[field];
	const value = typeof raw === 'number' ? raw : 0;
	if (value >= threshold) {
		return { open: true };
	}
	return {
		open: false,
		reason: `Gate count failed: data["${field}"] is ${value}, need >= ${threshold}`,
	};
}
