/**
 * Unified Gate Evaluator — field-based
 *
 * `evaluateGate(gate, data)` walks `gate.fields` and checks each field against
 * the runtime data store. The gate opens when ALL fields pass their checks.
 *
 * Field check types:
 *   scalar (boolean/string/number) — ops: exists / == / !=
 *   map — op: count (count entries matching a value, check >= min)
 *
 * Channels without a gate are always open — use `isChannelOpen()` as the entry point.
 */

import type { Gate, GateField, GateFieldCheck, Channel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of evaluating a gate. */
export interface GateEvalResult {
	/** Whether the gate is open (all fields passed). */
	open: boolean;
	/** Human-readable explanation when the gate is closed. */
	reason?: string;
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

const VALID_FIELD_TYPES = new Set(['boolean', 'string', 'number', 'map']);
const VALID_SCALAR_OPS = new Set(['exists', '==', '!=']);

/**
 * Validates an array of GateField objects at runtime.
 *
 * Since fields are deserialized from JSON (SQLite, RPC), they may be
 * malformed. This function checks structural validity before evaluation.
 *
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateFields(fields: unknown, path = 'fields'): string[] {
	const errors: string[] = [];

	if (!Array.isArray(fields)) {
		errors.push(`${path}: expected an array, got ${typeof fields}`);
		return errors;
	}

	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		const fp = `${path}[${i}]`;

		if (!field || typeof field !== 'object') {
			errors.push(`${fp}: expected an object, got ${typeof field}`);
			continue;
		}

		const f = field as Record<string, unknown>;

		if (typeof f.name !== 'string' || f.name.length === 0) {
			errors.push(`${fp}.name: expected non-empty string`);
		}

		if (typeof f.type !== 'string' || !VALID_FIELD_TYPES.has(f.type)) {
			errors.push(
				`${fp}.type: expected one of [boolean, string, number, map], got ${JSON.stringify(f.type)}`
			);
		}

		if (!Array.isArray(f.writers)) {
			errors.push(`${fp}.writers: expected array, got ${typeof f.writers}`);
		}

		// Validate check
		if (!f.check || typeof f.check !== 'object') {
			errors.push(`${fp}.check: expected an object, got ${typeof f.check}`);
		} else {
			const check = f.check as Record<string, unknown>;
			if (f.type === 'map') {
				if (check.op !== 'count') {
					errors.push(
						`${fp}.check.op: expected "count" for map field, got ${JSON.stringify(check.op)}`
					);
				}
				if (typeof check.min !== 'number') {
					errors.push(`${fp}.check.min: expected number, got ${typeof check.min}`);
				}
				if (check.match === undefined) {
					errors.push(`${fp}.check.match: required but missing`);
				}
			} else {
				if (typeof check.op !== 'string' || !VALID_SCALAR_OPS.has(check.op)) {
					errors.push(
						`${fp}.check.op: expected one of [exists, ==, !=], got ${JSON.stringify(check.op)}`
					);
				}
				if (check.op === 'exists' && check.value !== undefined) {
					errors.push(`${fp}.check: "value" is set but ignored when op is "exists"`);
				}
			}
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Gate creation/modification validators
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_INTERPRETERS = new Set(['bash', 'node', 'python3']);

/**
 * Validates a gate badge color.
 *
 * @param color  The color value to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateColor(color: unknown): string[] {
	const errors: string[] = [];

	if (color === undefined || color === null) {
		return errors;
	}

	if (typeof color !== 'string') {
		errors.push(`color: expected string, got ${typeof color}`);
		return errors;
	}

	if (!HEX_COLOR_RE.test(color)) {
		errors.push(`color: expected hex format #rrggbb, got "${color}"`);
	}

	return errors;
}

/**
 * Validates a gate label.
 *
 * @param label  The label value to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateLabel(label: unknown): string[] {
	const errors: string[] = [];

	if (label === undefined || label === null) {
		return errors;
	}

	if (typeof label !== 'string') {
		errors.push(`label: expected string, got ${typeof label}`);
		return errors;
	}

	if (label.length > 20) {
		errors.push(`label: must be at most 20 characters, got ${label.length}`);
	}

	return errors;
}

/**
 * Validates a gate script configuration.
 *
 * @param script  The script object to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateScript(script: unknown): string[] {
	const errors: string[] = [];

	if (script === undefined || script === null) {
		return errors;
	}

	if (!script || typeof script !== 'object') {
		errors.push(`script: expected object, got ${typeof script}`);
		return errors;
	}

	const s = script as Record<string, unknown>;

	if (typeof s.interpreter !== 'string' || !VALID_INTERPRETERS.has(s.interpreter)) {
		errors.push(
			`script.interpreter: expected one of [bash, node, python3], got ${JSON.stringify(s.interpreter)}`
		);
	}

	if (typeof s.source !== 'string' || s.source.length === 0) {
		errors.push('script.source: expected non-empty string');
	}

	if (s.timeoutMs !== undefined) {
		if (typeof s.timeoutMs !== 'number') {
			errors.push(`script.timeoutMs: expected number, got ${typeof s.timeoutMs}`);
		} else if (s.timeoutMs <= 0) {
			errors.push(`script.timeoutMs: must be positive, got ${s.timeoutMs}`);
		} else if (s.timeoutMs > 120000) {
			errors.push(`script.timeoutMs: must be at most 120000ms (120s), got ${s.timeoutMs}`);
		}
	}

	return errors;
}

/**
 * Validates a gate definition for creation or modification.
 *
 * This validator enforces structural rules on new/updated gates:
 *   - At least one of `fields` (non-empty) or `script` must be present.
 *   - When `fields` is present and non-empty, existing field validation runs.
 *   - Optional `color`, `label`, and `script` are validated when provided.
 *
 * **Important:** This validator is only applied to new/updated gates (via
 * `GateEditorPanel` and MCP tool handlers), never to existing gates loaded
 * from storage. Existing gates with `fields: []` remain valid at runtime.
 *
 * @param gate  The gate object to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGate(gate: unknown): string[] {
	const errors: string[] = [];

	if (!gate || typeof gate !== 'object') {
		errors.push(`gate: expected object, got ${typeof gate}`);
		return errors;
	}

	const g = gate as Record<string, unknown>;

	// Validate color
	if (g.color !== undefined) {
		errors.push(...validateGateColor(g.color));
	}

	// Validate label
	if (g.label !== undefined) {
		errors.push(...validateGateLabel(g.label));
	}

	// Validate script
	if (g.script !== undefined) {
		errors.push(...validateGateScript(g.script));
	}

	// Validate fields when present
	if (g.fields !== undefined && g.fields !== null) {
		if (Array.isArray(g.fields) && g.fields.length > 0) {
			errors.push(...validateGateFields(g.fields));
		}
	}

	// At least one of fields (non-empty) or script must be present
	const hasFields = Array.isArray(g.fields) && g.fields.length > 0;
	const hasScript = g.script !== undefined && g.script !== null;
	if (!hasFields && !hasScript) {
		errors.push('gate: must have at least one non-empty "fields" array or a "script"');
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
 * @param gates    Map of gate ID -> Gate (gate definitions, not runtime data).
 * @param gateData Map of gate ID -> runtime data.
 */
export function isChannelOpen(
	channel: Channel,
	gates: ReadonlyMap<string, Gate> | Record<string, Gate>,
	gateData?: ReadonlyMap<string, Record<string, unknown>> | Record<string, Record<string, unknown>>
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

	// Load runtime data if provided
	let data: Record<string, unknown> = {};
	if (gateData) {
		const d =
			gateData instanceof Map
				? gateData.get(channel.gateId)
				: (gateData as Record<string, Record<string, unknown>>)[channel.gateId];
		if (d) data = d;
	}

	return evaluateGate(gate, data);
}

// ---------------------------------------------------------------------------
// Gate evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates a Gate's fields against the provided runtime data store.
 *
 * Stateless — no I/O or side effects. The gate opens when ALL fields pass.
 *
 * @param gate The gate definition (fields, checks).
 * @param data Runtime data from the `gate_data` table.
 */
export function evaluateGate(gate: Gate, data: Record<string, unknown>): GateEvalResult {
	for (const field of gate.fields ?? []) {
		const result = evaluateFieldCheck(field, data);
		if (!result.open) return result;
	}
	return { open: true };
}

/**
 * Evaluates a single GateField's check against the provided data.
 */
export function evaluateFieldCheck(
	field: GateField,
	data: Record<string, unknown>
): GateEvalResult {
	const check: GateFieldCheck = field.check;

	if (check.op === 'count') {
		// Map check
		return evaluateCount(field.name, check.match, check.min, data);
	}

	// Scalar check
	return evaluateScalar(field.name, check.op, check.value, data);
}

// ---------------------------------------------------------------------------
// Primitive evaluators
// ---------------------------------------------------------------------------

function evaluateScalar(
	fieldName: string,
	op: '==' | '!=' | 'exists',
	expected: unknown,
	data: Record<string, unknown>
): GateEvalResult {
	switch (op) {
		case 'exists': {
			if (data[fieldName] !== undefined) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${fieldName}"] does not exist`,
			};
		}

		case '==': {
			const actual = data[fieldName];
			if (actual === expected) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${fieldName}"] is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
			};
		}

		case '!=': {
			const actual = data[fieldName];
			if (actual !== expected) {
				return { open: true };
			}
			return {
				open: false,
				reason: `Gate check failed: data["${fieldName}"] is ${JSON.stringify(actual)}, expected != ${JSON.stringify(expected)}`,
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
	fieldName: string,
	matchValue: unknown,
	min: number,
	data: Record<string, unknown>
): GateEvalResult {
	const raw = data[fieldName];

	// Field must be a non-null object (Record/map). Missing or non-object -> count 0.
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
		reason: `Gate count failed: data["${fieldName}"] has ${count} entries matching ${JSON.stringify(matchValue)}, need >= ${min}`,
	};
}
