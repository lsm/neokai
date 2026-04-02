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
	validateGateColor,
	validateGateLabel,
	validateGateScript,
	validateGate,
} from '../../../src/lib/space/runtime/gate-evaluator.ts';
import type { Gate, GateField, Channel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Scalar field — op: '==' (default comparison)
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (== op)', () => {
	test('opens when field matches expected value (boolean)', () => {
		const field: GateField = {
			name: 'approved',
			type: 'boolean',
			writers: ['*'],
			check: { op: '==', value: true },
		};
		const result = evaluateFieldCheck(field, { approved: true });
		expect(result.open).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test('closed when field does not match expected value', () => {
		const field: GateField = {
			name: 'approved',
			type: 'boolean',
			writers: ['*'],
			check: { op: '==', value: true },
		};
		const result = evaluateFieldCheck(field, { approved: false });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('expected true');
	});

	test('closed when field is missing (undefined !== true)', () => {
		const field: GateField = {
			name: 'approved',
			type: 'boolean',
			writers: ['*'],
			check: { op: '==', value: true },
		};
		const result = evaluateFieldCheck(field, {});
		expect(result.open).toBe(false);
	});

	test('matches string values', () => {
		const field: GateField = {
			name: 'result',
			type: 'string',
			writers: ['*'],
			check: { op: '==', value: 'passed' },
		};
		expect(evaluateFieldCheck(field, { result: 'passed' }).open).toBe(true);
		expect(evaluateFieldCheck(field, { result: 'failed' }).open).toBe(false);
	});

	test('matches number values', () => {
		const field: GateField = {
			name: 'count',
			type: 'number',
			writers: ['*'],
			check: { op: '==', value: 42 },
		};
		expect(evaluateFieldCheck(field, { count: 42 }).open).toBe(true);
		expect(evaluateFieldCheck(field, { count: 43 }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scalar field — op: 'exists'
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (exists op)', () => {
	test('opens when field is present (any truthy value)', () => {
		const field: GateField = {
			name: 'plan',
			type: 'string',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { plan: 'some plan' }).open).toBe(true);
	});

	test('opens when field is present with false value', () => {
		const field: GateField = {
			name: 'plan',
			type: 'boolean',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { plan: false }).open).toBe(true);
	});

	test('opens when field is present with null value', () => {
		const field: GateField = {
			name: 'plan',
			type: 'string',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { plan: null }).open).toBe(true);
	});

	test('opens when field is present with zero value', () => {
		const field: GateField = {
			name: 'count',
			type: 'number',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { count: 0 }).open).toBe(true);
	});

	test('opens when field is empty string', () => {
		const field: GateField = {
			name: 'plan',
			type: 'string',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { plan: '' }).open).toBe(true);
	});

	test('closed when field is undefined', () => {
		const field: GateField = {
			name: 'plan',
			type: 'string',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, {}).open).toBe(false);
	});

	test('closed when field is explicitly undefined', () => {
		const field: GateField = {
			name: 'plan',
			type: 'string',
			writers: ['*'],
			check: { op: 'exists' },
		};
		expect(evaluateFieldCheck(field, { plan: undefined }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scalar field — op: '!='
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (!= op)', () => {
	test('opens when field does not match', () => {
		const field: GateField = {
			name: 'x',
			type: 'number',
			writers: ['*'],
			check: { op: '!=', value: 42 },
		};
		expect(evaluateFieldCheck(field, { x: 43 }).open).toBe(true);
	});

	test('closed when field matches', () => {
		const field: GateField = {
			name: 'x',
			type: 'number',
			writers: ['*'],
			check: { op: '!=', value: 42 },
		};
		expect(evaluateFieldCheck(field, { x: 42 }).open).toBe(false);
	});

	test('opens when field is missing (undefined !== 42)', () => {
		const field: GateField = {
			name: 'x',
			type: 'number',
			writers: ['*'],
			check: { op: '!=', value: 42 },
		};
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
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
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
			{
				name: 'votes',
				type: 'map',
				writers: ['reviewer'],
				check: { op: 'count', match: 'approved', min: 3 },
			},
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

// ---------------------------------------------------------------------------
// validateGateColor
// ---------------------------------------------------------------------------

describe('validateGateColor', () => {
	test('accepts valid hex color', () => {
		expect(validateGateColor('#ff5500')).toHaveLength(0);
	});

	test('accepts uppercase hex color', () => {
		expect(validateGateColor('#FF5500')).toHaveLength(0);
		expect(validateGateColor('#AABBCC')).toHaveLength(0);
	});

	test('accepts mixed-case hex color', () => {
		expect(validateGateColor('#aAbBcC')).toHaveLength(0);
	});

	test('accepts null (optional field)', () => {
		expect(validateGateColor(null)).toHaveLength(0);
	});

	test('accepts undefined (optional field)', () => {
		expect(validateGateColor(undefined)).toHaveLength(0);
	});

	test('rejects named color "red"', () => {
		const errors = validateGateColor('red');
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('#rrggbb');
	});

	test('rejects hex without hash prefix', () => {
		const errors = validateGateColor('ff5500');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects 3-digit hex shorthand', () => {
		const errors = validateGateColor('#f50');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects 8-digit hex with alpha', () => {
		const errors = validateGateColor('#ff5500ff');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects non-string type', () => {
		const errors = validateGateColor(42);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected string');
	});
});

// ---------------------------------------------------------------------------
// validateGateLabel
// ---------------------------------------------------------------------------

describe('validateGateLabel', () => {
	test('accepts valid label', () => {
		expect(validateGateLabel('approval')).toHaveLength(0);
	});

	test('accepts empty string', () => {
		expect(validateGateLabel('')).toHaveLength(0);
	});

	test('accepts null (optional field)', () => {
		expect(validateGateLabel(null)).toHaveLength(0);
	});

	test('accepts undefined (optional field)', () => {
		expect(validateGateLabel(undefined)).toHaveLength(0);
	});

	test('accepts label at exactly 20 characters', () => {
		expect(validateGateLabel('12345678901234567890')).toHaveLength(0);
	});

	test('rejects label longer than 20 characters', () => {
		const errors = validateGateLabel('123456789012345678901');
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('20 characters');
	});

	test('rejects non-string type', () => {
		const errors = validateGateLabel(42);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected string');
	});
});

// ---------------------------------------------------------------------------
// validateGateScript
// ---------------------------------------------------------------------------

describe('validateGateScript', () => {
	test('accepts valid bash script', () => {
		expect(validateGateScript({ interpreter: 'bash', source: 'echo hello' })).toHaveLength(0);
	});

	test('accepts valid node script', () => {
		expect(validateGateScript({ interpreter: 'node', source: 'process.exit(0)' })).toHaveLength(0);
	});

	test('accepts valid python3 script', () => {
		expect(validateGateScript({ interpreter: 'python3', source: 'print("hello")' })).toHaveLength(
			0
		);
	});

	test('accepts script with timeoutMs', () => {
		expect(
			validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 5000 })
		).toHaveLength(0);
	});

	test('accepts null (optional field)', () => {
		expect(validateGateScript(null)).toHaveLength(0);
	});

	test('accepts undefined (optional field)', () => {
		expect(validateGateScript(undefined)).toHaveLength(0);
	});

	test('rejects invalid interpreter "ruby"', () => {
		const errors = validateGateScript({ interpreter: 'ruby', source: 'puts "hi"' });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('interpreter');
		expect(errors[0]).toContain('bash');
	});

	test('rejects invalid interpreter "javascript"', () => {
		const errors = validateGateScript({ interpreter: 'javascript', source: 'true' });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('interpreter');
	});

	test('rejects empty source string', () => {
		const errors = validateGateScript({ interpreter: 'bash', source: '' });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('source');
		expect(errors[0]).toContain('non-empty');
	});

	test('rejects non-string source', () => {
		const errors = validateGateScript({ interpreter: 'bash', source: 42 });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('source');
	});

	test('rejects non-object input', () => {
		const errors = validateGateScript('not an object');
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected object');
	});

	test('rejects false as script', () => {
		const errors = validateGateScript(false);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected object');
	});

	test('rejects 0 as script', () => {
		const errors = validateGateScript(0);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected object');
	});

	test('rejects timeoutMs exceeding 120000', () => {
		const errors = validateGateScript({
			interpreter: 'bash',
			source: 'echo hi',
			timeoutMs: 200000,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('120000');
	});

	test('rejects timeoutMs at exactly 120001', () => {
		const errors = validateGateScript({
			interpreter: 'bash',
			source: 'echo hi',
			timeoutMs: 120001,
		});
		expect(errors.length).toBeGreaterThan(0);
	});

	test('accepts timeoutMs at exactly 120000', () => {
		expect(
			validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 120000 })
		).toHaveLength(0);
	});

	test('rejects negative timeoutMs', () => {
		const errors = validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: -1000 });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('positive');
	});

	test('rejects zero timeoutMs', () => {
		const errors = validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 0 });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('positive');
	});

	test('rejects non-number timeoutMs', () => {
		const errors = validateGateScript({
			interpreter: 'bash',
			source: 'echo hi',
			timeoutMs: '30s',
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('timeoutMs');
	});
});

// ---------------------------------------------------------------------------
// validateGate
// ---------------------------------------------------------------------------

describe('validateGate', () => {
	test('gate with empty fields and no script returns errors', () => {
		const errors = validateGate({ id: 'g1', fields: [], resetOnCycle: false });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('at least one'))).toBe(true);
	});

	test('gate with only non-empty fields is valid', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		});
		expect(errors).toHaveLength(0);
	});

	test('gate with only script is valid', () => {
		const errors = validateGate({
			id: 'g1',
			script: { interpreter: 'node', source: 'process.exit(0)' },
			resetOnCycle: false,
		});
		expect(errors).toHaveLength(0);
	});

	test('gate with both fields and script is valid', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: { interpreter: 'bash', source: 'echo hi' },
			resetOnCycle: false,
		});
		expect(errors).toHaveLength(0);
	});

	test('gate with no fields and no script returns error', () => {
		const errors = validateGate({ id: 'g1', resetOnCycle: false });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('at least one'))).toBe(true);
	});

	test('gate with invalid color produces error', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			color: 'red',
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('color'))).toBe(true);
	});

	test('gate with valid color passes', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			color: '#ff5500',
			resetOnCycle: false,
		});
		expect(errors).toHaveLength(0);
	});

	test('gate with label longer than 20 chars produces error', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			label: 'this label is way too long for the limit',
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('label'))).toBe(true);
	});

	test('gate with valid label passes', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			label: 'approval gate',
			resetOnCycle: false,
		});
		expect(errors).toHaveLength(0);
	});

	test('gate with invalid script interpreter produces error', () => {
		const errors = validateGate({
			id: 'g1',
			script: { interpreter: 'ruby', source: 'puts "hi"' },
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('interpreter'))).toBe(true);
	});

	test('gate with empty script source produces error', () => {
		const errors = validateGate({
			id: 'g1',
			script: { interpreter: 'bash', source: '' },
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('source'))).toBe(true);
	});

	test('gate with script timeoutMs exceeding 120000 produces error', () => {
		const errors = validateGate({
			id: 'g1',
			script: { interpreter: 'bash', source: 'echo hi', timeoutMs: 200000 },
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('timeoutMs'))).toBe(true);
	});

	test('rejects non-object gate input', () => {
		const errors = validateGate('not an object');
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected object');
	});

	test('rejects null gate input', () => {
		const errors = validateGate(null);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected object');
	});

	test('runs validateGateFields when fields are present and non-empty', () => {
		const errors = validateGate({
			id: 'g1',
			fields: [{ name: '', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		// Should include the field-level error for empty name
		expect(errors.some((e) => e.includes('name'))).toBe(true);
	});

	test('does not run validateGateFields when fields is empty array', () => {
		const errors = validateGate({ id: 'g1', fields: [], resetOnCycle: false });
		// Should only have the "at least one" error, no field-level errors
		expect(errors.every((e) => !e.includes('[0]'))).toBe(true);
	});

	test('runs validateGateFields for non-array fields value', () => {
		const errors = validateGate({ id: 'g1', fields: 'bad', resetOnCycle: false });
		// Should have both the "expected an array" error and the "at least one" error
		expect(errors.some((e) => e.includes('expected an array'))).toBe(true);
		expect(errors.some((e) => e.includes('at least one'))).toBe(true);
	});

	test('collects all errors from color, label, script, and fields', () => {
		const errors = validateGate({
			id: 'g1',
			color: 'red',
			label: 'a label that is definitely way too long for this',
			script: { interpreter: 'ruby', source: '' },
			fields: [],
			resetOnCycle: false,
		});
		// script is present so "at least one" check passes, but color/label/script have errors
		expect(errors.some((e) => e.includes('color'))).toBe(true);
		expect(errors.some((e) => e.includes('label'))).toBe(true);
		expect(errors.some((e) => e.includes('interpreter'))).toBe(true);
		expect(errors.some((e) => e.includes('source'))).toBe(true);
		// No "at least one" error because script is present
		expect(errors.some((e) => e.includes('at least one'))).toBe(false);
	});
});
