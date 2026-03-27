/**
 * Unified Gate Evaluator (M1.2)
 *
 * Single `evaluateGate(gate)` function that handles all four condition types
 * (check, count, all, any) including recursive all/any.
 *
 * The evaluator reads from the gate's own `data` store — callers populate
 * `gate.data` with runtime data from the `gate_data` table before evaluation.
 *
 * Condition types:
 *   check — field check with operator: exists / == / !=
 *   count — map-counting: count entries matching matchValue, check >= min
 *   all   — composite AND: all sub-conditions must pass (short-circuits on failure)
 *   any   — composite OR: at least one sub-condition must pass (short-circuits on success)
 *
 * Channels without a gate are always open — use `isChannelOpen()` as the entry point.
 */

import type { Gate, Channel, GateCondition } from '@neokai/shared';

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
const VALID_CHECK_OPS = new Set(['exists', '==', '!=']);

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
			if (cond.op !== undefined && (typeof cond.op !== 'string' || !VALID_CHECK_OPS.has(cond.op))) {
				errors.push(`${path}.op: expected one of [exists, ==, !=], got ${JSON.stringify(cond.op)}`);
			}
			// Warn when value is set but op is 'exists' (value is ignored by exists)
			if (cond.op === 'exists' && cond.value !== undefined) {
				errors.push(`${path}: "value" is set but ignored when op is "exists"`);
			}
			break;

		case 'count':
			if (typeof cond.field !== 'string' || cond.field.length === 0) {
				errors.push(`${path}.field: expected non-empty string`);
			}
			if (typeof cond.min !== 'number') {
				errors.push(`${path}.min: expected number, got ${typeof cond.min}`);
			}
			if (cond.matchValue === undefined) {
				errors.push(`${path}.matchValue: required but missing`);
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
// Channel helper
// ---------------------------------------------------------------------------

/**
 * Checks whether a channel is open for message delivery.
 *
 * - Channels without a `gateId` are always open (no evaluation needed).
 * - Channels with a `gateId` look up the gate in `gates` and evaluate it.
 * - If the gate is not found in the map, the channel is treated as closed
 *   (missing gate = misconfiguration, fail closed).
 *
 * @param channel  The channel to check.
 * @param gates    Map of gate ID → Gate (with runtime data already populated).
 */
export function isChannelOpen(
	channel: Channel,
	gates: ReadonlyMap<string, Gate> | Record<string, Gate>
): GateEvalResult {
	if (!channel.gateId) {
		return { open: true };
	}

	const gate =
		gates instanceof Map
			? gates.get(channel.gateId)
			: (gates as Record<string, Gate>)[channel.gateId];
	if (!gate) {
		return {
			open: false,
			reason: `Gate "${channel.gateId}" not found — channel "${channel.id}" is closed (misconfiguration)`,
		};
	}

	return evaluateGate(gate);
}

// ---------------------------------------------------------------------------
// Gate evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates a Gate's condition tree against the gate's own data store.
 *
 * Stateless — reads from `gate.data`. No I/O or side effects.
 * Callers should populate `gate.data` with runtime data from the `gate_data`
 * table before calling this function.
 */
export function evaluateGate(gate: Gate): GateEvalResult {
	return evaluateCondition(gate.condition, gate.data);
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
			return evaluateCheck(condition.field, condition.op ?? '==', condition.value, data);

		case 'count':
			return evaluateCount(condition.field, condition.matchValue, condition.min, data);

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
	op: 'exists' | '==' | '!=',
	expected: unknown,
	data: Record<string, unknown>
): GateEvalResult {
	switch (op) {
		case 'exists': {
			if (data[field] !== undefined) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${field}"] does not exist`,
			};
		}

		case '==': {
			const actual = data[field];
			if (actual === expected) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${field}"] is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
			};
		}

		case '!=': {
			const actual = data[field];
			if (actual !== expected) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${field}"] is ${JSON.stringify(actual)}, expected != ${JSON.stringify(expected)}`,
			};
		}

		default: {
			return {
				open: false,
				reason: `Gate check failed: unknown op "${op as string}"`,
			};
		}
	}
}

function evaluateCount(
	field: string,
	matchValue: unknown,
	min: number,
	data: Record<string, unknown>
): GateEvalResult {
	const raw = data[field];

	// Field must be a non-null object (Record/map). Missing or non-object → count 0.
	let count = 0;
	if (raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
		const map = raw as Record<string, unknown>;
		for (const val of Object.values(map)) {
			if (val === matchValue) count++;
		}
	}

	if (count >= min) {
		return { open: true };
	}
	return {
		open: false,
		reason: `Gate count failed: data["${field}"] has ${count} entries matching ${JSON.stringify(matchValue)}, need >= ${min}`,
	};
}
