/**
 * GateEvaluator — evaluates GateCondition trees against gate data.
 *
 * This evaluator works with the new separated Gate/Channel system (M1.1).
 * It reads gate data from the data store and evaluates the gate's condition
 * tree to determine whether the gate is open or closed.
 *
 * Since conditions are deserialized from JSON at runtime, the evaluator
 * includes runtime validation via `validateGateCondition` to catch malformed
 * objects before they reach the evaluation logic.
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
// Runtime validation
// ---------------------------------------------------------------------------

const VALID_CONDITION_TYPES = new Set(['check', 'count', 'all', 'any']);

/**
 * Validates a GateCondition object at runtime.
 *
 * Since conditions are deserialized from JSON (SQLite, RPC), they may be
 * malformed. This function checks structural validity before evaluation.
 *
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateCondition(condition: unknown, path = 'condition'): string[] {
	const errors: string[] = [];

	if (!condition || typeof condition !== 'object') {
		errors.push(`${path}: expected an object, got ${typeof condition}`);
		return errors;
	}

	const cond = condition as Record<string, unknown>;
	if (typeof cond.type !== 'string' || !VALID_CONDITION_TYPES.has(cond.type)) {
		errors.push(
			`${path}.type: expected one of [check, count, all, any], got ${JSON.stringify(cond.type)}`
		);
		return errors;
	}

	switch (cond.type) {
		case 'check':
			if (typeof cond.field !== 'string' || cond.field.length === 0) {
				errors.push(`${path}.field: expected non-empty string`);
			}
			// value can be anything — no validation needed
			break;

		case 'count':
			if (typeof cond.field !== 'string' || cond.field.length === 0) {
				errors.push(`${path}.field: expected non-empty string`);
			}
			if (typeof cond.threshold !== 'number') {
				errors.push(`${path}.threshold: expected number, got ${typeof cond.threshold}`);
			}
			break;

		case 'all':
		case 'any':
			if (!Array.isArray(cond.conditions)) {
				errors.push(`${path}.conditions: expected array, got ${typeof cond.conditions}`);
			} else {
				for (let i = 0; i < cond.conditions.length; i++) {
					errors.push(...validateGateCondition(cond.conditions[i], `${path}.conditions[${i}]`));
				}
			}
			break;
	}

	return errors;
}

// ---------------------------------------------------------------------------
// GateEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates a Gate's condition tree against the current gate data.
 *
 * Stateless — all data is passed in. No I/O or side effects.
 * Callers should validate condition structure with `validateGateCondition`
 * before calling this function with data from untrusted JSON sources.
 */
export function evaluateGate(gate: Gate, data: Record<string, unknown>): GateEvalResult {
	return evaluateCondition(gate.condition, data);
}

/**
 * Evaluates a single GateCondition node against the provided data.
 * Recursive for composite conditions (`all`, `any`).
 *
 * If the condition has an unrecognized `type`, returns `{ open: false }`
 * with a descriptive reason. This handles malformed JSON gracefully at runtime.
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
				reason:
					reasons.length > 0
						? `None of the conditions passed: [${reasons.join('; ')}]`
						: 'Gate blocked: "any" condition has no sub-conditions to evaluate',
			};
		}

		default: {
			// Runtime fallback for malformed JSON — condition.type is not in the union.
			// The `never` assertion is compile-time only; at runtime unknown types land here.
			const unknownType = (condition as { type: string }).type;
			return {
				open: false,
				reason: `Gate blocked: unknown condition type "${unknownType}"`,
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
