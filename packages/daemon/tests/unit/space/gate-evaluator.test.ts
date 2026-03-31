/**
 * Field-Based Gate Evaluator Unit Tests
 *
 * Covers field-based evaluation:
 *   scalar fields (boolean/string/number) — ops: exists / == / !=
 *   map fields — op: count (count entries matching a value, check >= min)
 *
 * Also covers:
 *   - evaluateGate: walks gate.fields, gate opens when ALL fields pass
 *   - evaluateFieldCheck: single field evaluation
 *   - isChannelOpen: gateless channels always open, gated channels delegate
 *   - validateGateFields: runtime validation of field definitions
 */

import { describe, test, expect } from 'bun:test';
import {
	evaluateGate,
	evaluateFieldCheck,
	isChannelOpen,
	validateGateFields,
} from '../../../src/lib/space/runtime/gate-evaluator.ts';
import type { Gate, GateField, Channel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Scalar field — op: '==' (default comparison)
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (== op)', () => {
	test('opens when field matches expected value (boolean)', () => {
		const field: GateField = { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } };
		const result = evaluateFieldCheck(field, { approved: true });
		expect(result.open).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test('closed when field does not match expected value', () => {
		const field: GateField = { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } };
		const result = evaluateFieldCheck(field, { approved: false });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('expected true');
	});

	test('closed when field is missing (undefined !== true)', () => {
		const field: GateField = { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } };
		const result = evaluateFieldCheck(field, {});
		expect(result.open).toBe(false);
	});

	test('matches string values', () => {
		const field: GateField = { name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } };
		expect(evaluateFieldCheck(field, { result: 'passed' }).open).toBe(true);
		expect(evaluateFieldCheck(field, { result: 'failed' }).open).toBe(false);
	});

	test('matches number values', () => {
		const field: GateField = { name: 'count', type: 'number', writers: ['*'], check: { op: '==', value: 42 } };
		expect(evaluateFieldCheck(field, { count: 42 }).open).toBe(true);
		expect(evaluateFieldCheck(field, { count: 43 }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scalar field — op: 'exists'
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (exists op)', () => {
	test('opens when field is present (any truthy value)', () => {
		const field: GateField = { name: 'plan', type: 'string', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { plan: 'some plan' }).open).toBe(true);
	});

	test('opens when field is present with false value', () => {
		const field: GateField = { name: 'plan', type: 'boolean', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { plan: false }).open).toBe(true);
	});

	test('opens when field is present with null value', () => {
		const field: GateField = { name: 'plan', type: 'string', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { plan: null }).open).toBe(true);
	});

	test('opens when field is present with zero value', () => {
		const field: GateField = { name: 'count', type: 'number', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { count: 0 }).open).toBe(true);
	});

	test('opens when field is empty string', () => {
		const field: GateField = { name: 'plan', type: 'string', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { plan: '' }).open).toBe(true);
	});

	test('closed when field is undefined', () => {
		const field: GateField = { name: 'plan', type: 'string', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, {}).open).toBe(false);
	});

	test('closed when field is explicitly undefined', () => {
		const field: GateField = { name: 'plan', type: 'string', writers: ['*'], check: { op: 'exists' } };
		expect(evaluateFieldCheck(field, { plan: undefined }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scalar field — op: '!='
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (!= op)', () => {
	test('opens when field does not match', () => {
		const field: GateField = { name: 'x', type: 'number', writers: ['*'], check: { op: '!=', value: 42 } };
		expect(evaluateFieldCheck(field, { x: 43 }).open).toBe(true);
	});

	test('closed when field matches', () => {
		const field: GateField = { name: 'x', type: 'number', writers: ['*'], check: { op: '!=', value: 42 } };
		expect(evaluateFieldCheck(field, { x: 42 }).open).toBe(false);
	});

	test('opens when field is missing (undefined !== 42)', () => {
		const field: GateField = { name: 'x', type: 'number', writers: ['*'], check: { op: '!=', value: 42 } };
		expect(evaluateFieldCheck(field, {}).open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Map field — op: 'count'
// ---------------------------------------------------------------------------

describe('GateEvaluator — map field (count op)', () => {
	test('opens when enough entries match', () => {
		const field: GateField = {
			name: 'reviews',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'approved', min: 2 },
		};
		const data = { reviews: { alice: 'approved', bob: 'approved', carol: 'pending' } };
		expect(evaluateFieldCheck(field, data).open).toBe(true);
	});

	test('closed when not enough entries match', () => {
		const field: GateField = {
			name: 'reviews',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'approved', min: 2 },
		};
		const data = { reviews: { alice: 'approved', bob: 'pending' } };
		expect(evaluateFieldCheck(field, data).open).toBe(false);
	});

	test('closed when field is missing', () => {
		const field: GateField = {
			name: 'reviews',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'approved', min: 1 },
		};
		expect(evaluateFieldCheck(field, {}).open).toBe(false);
	});

	test('closed when field is not an object', () => {
		const field: GateField = {
			name: 'reviews',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'approved', min: 1 },
		};
		expect(evaluateFieldCheck(field, { reviews: 'not a map' }).open).toBe(false);
	});

	test('closed when field is an array', () => {
		const field: GateField = {
			name: 'reviews',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'approved', min: 1 },
		};
		expect(evaluateFieldCheck(field, { reviews: ['approved'] }).open).toBe(false);
	});

	test('opens with exact min count', () => {
		const field: GateField = {
			name: 'votes',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'ok', min: 1 },
		};
		expect(evaluateFieldCheck(field, { votes: { a: 'ok' } }).open).toBe(true);
	});

	test('closed with empty map', () => {
		const field: GateField = {
			name: 'votes',
			type: 'map',
			writers: ['*'],
			check: { op: 'count', match: 'ok', min: 1 },
		};
		expect(evaluateFieldCheck(field, { votes: {} }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// evaluateGate — multiple fields (ALL must pass)
// ---------------------------------------------------------------------------

describe('GateEvaluator — evaluateGate (multiple fields)', () => {
	test('opens when all fields pass', () => {
		const gate: Gate = {
			id: 'g1',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
				{ name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
			],
			resetOnCycle: false,
		};
		expect(evaluateGate(gate, { approved: true, result: 'passed' }).open).toBe(true);
	});

	test('closed when any field fails', () => {
		const gate: Gate = {
			id: 'g1',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
				{ name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
			],
			resetOnCycle: false,
		};
		expect(evaluateGate(gate, { approved: true, result: 'failed' }).open).toBe(false);
	});

	test('opens with empty fields (no checks)', () => {
		const gate: Gate = { id: 'g1', fields: [], resetOnCycle: false };
		expect(evaluateGate(gate, {}).open).toBe(true);
	});

	test('short-circuits on first failed field', () => {
		const gate: Gate = {
			id: 'g1',
			fields: [
				{ name: 'x', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
				{ name: 'y', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate, { x: false, y: true });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('x');
	});
});

// ---------------------------------------------------------------------------
// isChannelOpen
// ---------------------------------------------------------------------------

describe('GateEvaluator — isChannelOpen', () => {
	test('channel without gateId is always open', () => {
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b' };
		const result = isChannelOpen(channel, new Map());
		expect(result.open).toBe(true);
	});

	test('channel with missing gate is closed', () => {
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'missing' };
		const result = isChannelOpen(channel, new Map());
		expect(result.open).toBe(false);
		expect(result.reason).toContain('not found');
	});

	test('channel with gate delegates to evaluateGate', () => {
		const gate: Gate = {
			id: 'g1',
			fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
			resetOnCycle: false,
		};
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
		const gates = new Map<string, Gate>([['g1', gate]]);

		// Without data — field not satisfied
		const closed = isChannelOpen(channel, gates, new Map());
		expect(closed.open).toBe(false);

		// With data — field satisfied
		const gateData = new Map<string, Record<string, unknown>>([['g1', { approved: true }]]);
		const open = isChannelOpen(channel, gates, gateData);
		expect(open.open).toBe(true);
	});

	test('works with Record-based gate lookups', () => {
		const gate: Gate = {
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
		const gates: Record<string, Gate> = { g1: gate };
		const gateData: Record<string, Record<string, unknown>> = { g1: { done: true } };

		expect(isChannelOpen(channel, gates, gateData).open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateGateFields
// ---------------------------------------------------------------------------

describe('validateGateFields', () => {
	test('valid boolean field with == check', () => {
		const errors = validateGateFields([
			{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
		]);
		expect(errors).toHaveLength(0);
	});

	test('valid string field with exists check', () => {
		const errors = validateGateFields([
			{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } },
		]);
		expect(errors).toHaveLength(0);
	});

	test('valid map field with count check', () => {
		const errors = validateGateFields([
			{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 3 } },
		]);
		expect(errors).toHaveLength(0);
	});

	test('warns when value is set on exists op', () => {
		const errors = validateGateFields([
			{ name: 'x', type: 'string', writers: ['*'], check: { op: 'exists', value: 'ignored' } },
		]);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('ignored');
	});

	test('rejects non-array input', () => {
		const errors = validateGateFields('not an array');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects field with missing name', () => {
		const errors = validateGateFields([
			{ name: '', type: 'boolean', writers: ['*'], check: { op: 'exists' } },
		]);
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects field with invalid type', () => {
		const errors = validateGateFields([
			{ name: 'x', type: 'invalid', writers: ['*'], check: { op: 'exists' } },
		]);
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects map field with scalar op', () => {
		const errors = validateGateFields([
			{ name: 'votes', type: 'map', writers: ['*'], check: { op: '==' } },
		]);
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects count check missing min', () => {
		const errors = validateGateFields([
			{ name: 'votes', type: 'map', writers: ['*'], check: { op: 'count', match: 'ok' } },
		]);
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects count check missing match', () => {
		const errors = validateGateFields([
			{ name: 'votes', type: 'map', writers: ['*'], check: { op: 'count', min: 1 } },
		]);
		expect(errors.length).toBeGreaterThan(0);
	});
});
