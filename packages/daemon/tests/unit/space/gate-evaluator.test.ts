/**
 * Unified Gate Evaluator Unit Tests (M1.2)
 *
 * Covers all 4 GateCondition types:
 *   check — field check with operators: exists / == / !=
 *   count — map-counting: count entries matching matchValue, check >= min
 *   all   — composite AND (recursive, short-circuits on failure)
 *   any   — composite OR (recursive, short-circuits on success)
 *
 * Also covers:
 *   - evaluateGate: reads from gate.data directly
 *   - isChannelOpen: gateless channels always open, gated channels delegate
 *   - Edge cases: missing fields, zero values, nested composites
 *   - Validation: validateGateCondition for all types and ops
 */

import { describe, test, expect } from 'bun:test';
import {
	evaluateGate,
	evaluateCondition,
	isChannelOpen,
	validateGateCondition,
} from '../../../src/lib/space/runtime/gate-evaluator.ts';
import type { Gate, Channel, GateCondition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// check condition — op: '==' (default)
// ---------------------------------------------------------------------------

describe('GateEvaluator — check condition (== op, default)', () => {
	test('opens when field matches expected value', () => {
		const condition: GateCondition = { type: 'check', field: 'approved', value: true };
		const result = evaluateCondition(condition, { approved: true });
		expect(result.open).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test('blocks when field does not match', () => {
		const condition: GateCondition = { type: 'check', field: 'approved', value: true };
		const result = evaluateCondition(condition, { approved: false });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('approved');
		expect(result.reason).toContain('false');
	});

	test('blocks when field is missing from data', () => {
		const condition: GateCondition = { type: 'check', field: 'approved', value: true };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('undefined');
	});

	test('matches string values', () => {
		const condition: GateCondition = { type: 'check', field: 'result', value: 'passed' };
		const result = evaluateCondition(condition, { result: 'passed' });
		expect(result.open).toBe(true);
	});

	test('blocks on string mismatch', () => {
		const condition: GateCondition = { type: 'check', field: 'result', value: 'passed' };
		const result = evaluateCondition(condition, { result: 'failed' });
		expect(result.open).toBe(false);
	});

	test('matches null value', () => {
		const condition: GateCondition = { type: 'check', field: 'error', value: null };
		const result = evaluateCondition(condition, { error: null });
		expect(result.open).toBe(true);
	});

	test('matches numeric value', () => {
		const condition: GateCondition = { type: 'check', field: 'count', value: 42 };
		const result = evaluateCondition(condition, { count: 42 });
		expect(result.open).toBe(true);
	});

	test('explicit op: "==" behaves same as default', () => {
		const condition: GateCondition = { type: 'check', field: 'x', op: '==', value: 10 };
		expect(evaluateCondition(condition, { x: 10 }).open).toBe(true);
		expect(evaluateCondition(condition, { x: 20 }).open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// check condition — op: 'exists'
// ---------------------------------------------------------------------------

describe('GateEvaluator — check condition (exists op)', () => {
	test('opens when field is present', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, { plan: 'some plan text' });
		expect(result.open).toBe(true);
	});

	test('opens when field is present with null value', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, { plan: null });
		expect(result.open).toBe(true);
	});

	test('opens when field is present with false value', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, { plan: false });
		expect(result.open).toBe(true);
	});

	test('opens when field is present with empty string', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, { plan: '' });
		expect(result.open).toBe(true);
	});

	test('opens when field is present with zero', () => {
		const condition: GateCondition = { type: 'check', field: 'count', op: 'exists' };
		const result = evaluateCondition(condition, { count: 0 });
		expect(result.open).toBe(true);
	});

	test('blocks when field is missing', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('does not exist');
	});

	test('blocks when field is explicitly undefined', () => {
		const condition: GateCondition = { type: 'check', field: 'plan', op: 'exists' };
		const result = evaluateCondition(condition, { plan: undefined });
		expect(result.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// check condition — op: '!='
// ---------------------------------------------------------------------------

describe('GateEvaluator — check condition (!= op)', () => {
	test('opens when field does not equal value', () => {
		const condition: GateCondition = {
			type: 'check',
			field: 'status',
			op: '!=',
			value: 'rejected',
		};
		const result = evaluateCondition(condition, { status: 'approved' });
		expect(result.open).toBe(true);
	});

	test('blocks when field equals value', () => {
		const condition: GateCondition = {
			type: 'check',
			field: 'status',
			op: '!=',
			value: 'rejected',
		};
		const result = evaluateCondition(condition, { status: 'rejected' });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('!=');
	});

	test('opens when field is missing (undefined != value)', () => {
		const condition: GateCondition = {
			type: 'check',
			field: 'status',
			op: '!=',
			value: 'rejected',
		};
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(true);
	});

	test('opens when comparing different types', () => {
		const condition: GateCondition = { type: 'check', field: 'x', op: '!=', value: 42 };
		const result = evaluateCondition(condition, { x: '42' });
		expect(result.open).toBe(true); // strict inequality: '42' !== 42
	});
});

// ---------------------------------------------------------------------------
// count condition (map-counting)
// ---------------------------------------------------------------------------

describe('GateEvaluator — count condition (map-counting)', () => {
	test('opens when matching entries >= min', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 2,
		};
		const result = evaluateCondition(condition, {
			reviews: { alice: 'approved', bob: 'approved', carol: 'pending' },
		});
		expect(result.open).toBe(true);
	});

	test('opens when matching entries equal min exactly', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 2,
		};
		const result = evaluateCondition(condition, {
			reviews: { alice: 'approved', bob: 'approved' },
		});
		expect(result.open).toBe(true);
	});

	test('blocks when matching entries < min', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 2,
		};
		const result = evaluateCondition(condition, {
			reviews: { alice: 'approved', bob: 'pending' },
		});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('1');
		expect(result.reason).toContain('>= 2');
	});

	test('treats missing field as 0 matching entries', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 1,
		};
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('0');
	});

	test('treats non-object field as 0 matching entries', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 1,
		};
		const result = evaluateCondition(condition, { reviews: 'not an object' });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('0');
	});

	test('treats null field as 0 matching entries', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 1,
		};
		const result = evaluateCondition(condition, { reviews: null });
		expect(result.open).toBe(false);
	});

	test('treats array field as 0 matching entries (not a record)', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 1,
		};
		const result = evaluateCondition(condition, { reviews: ['approved'] });
		expect(result.open).toBe(false);
	});

	test('opens with min of 0 when field is empty map', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 0,
		};
		const result = evaluateCondition(condition, { reviews: {} });
		expect(result.open).toBe(true);
	});

	test('opens with min of 0 when field is missing', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 0,
		};
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(true);
	});

	test('counts boolean matchValue correctly', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'votes',
			matchValue: true,
			min: 2,
		};
		const result = evaluateCondition(condition, {
			votes: { alice: true, bob: true, carol: false },
		});
		expect(result.open).toBe(true);
	});

	test('counts numeric matchValue correctly', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'scores',
			matchValue: 100,
			min: 2,
		};
		const result = evaluateCondition(condition, {
			scores: { alice: 100, bob: 95, carol: 100 },
		});
		expect(result.open).toBe(true);
	});

	test('does not count entries that do not strictly equal matchValue', () => {
		const condition: GateCondition = {
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 1,
		};
		const result = evaluateCondition(condition, {
			reviews: { alice: 'Approved', bob: 'APPROVED' }, // case-sensitive
		});
		expect(result.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// all condition (AND)
// ---------------------------------------------------------------------------

describe('GateEvaluator — all condition (AND)', () => {
	test('opens when all sub-conditions pass', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			approved: true,
			reviews: { a: 'approved', b: 'approved' },
		});
		expect(result.open).toBe(true);
	});

	test('blocks when first sub-condition fails (short-circuit)', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			approved: false,
			reviews: { a: 'approved', b: 'approved' },
		});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('approved');
	});

	test('blocks when second sub-condition fails', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			approved: true,
			reviews: { a: 'approved' },
		});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('reviews');
	});

	test('opens with empty conditions list', () => {
		const condition: GateCondition = { type: 'all', conditions: [] };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// any condition (OR)
// ---------------------------------------------------------------------------

describe('GateEvaluator — any condition (OR)', () => {
	test('opens when first sub-condition passes (short-circuit)', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: true, reviews: {} });
		expect(result.open).toBe(true);
	});

	test('opens when second sub-condition passes', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			approved: false,
			reviews: { a: 'approved', b: 'approved', c: 'approved' },
		});
		expect(result.open).toBe(true);
	});

	test('blocks when all sub-conditions fail', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			approved: false,
			reviews: { a: 'pending' },
		});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('None of the conditions passed');
	});

	test('blocks with empty conditions list and provides reason', () => {
		const condition: GateCondition = { type: 'any', conditions: [] };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('no sub-conditions');
	});
});

// ---------------------------------------------------------------------------
// Nested composite conditions
// ---------------------------------------------------------------------------

describe('GateEvaluator — nested composites', () => {
	test('all containing any: passes when inner any passes', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{
					type: 'any',
					conditions: [
						{ type: 'check', field: 'fast_track', value: true },
						{ type: 'count', field: 'approvals', matchValue: 'yes', min: 2 },
					],
				},
				{ type: 'check', field: 'tests_passed', value: true },
			],
		};
		const result = evaluateCondition(condition, {
			fast_track: true,
			approvals: {},
			tests_passed: true,
		});
		expect(result.open).toBe(true);
	});

	test('any containing all: passes when inner all passes', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'override', value: true },
				{
					type: 'all',
					conditions: [
						{ type: 'check', field: 'reviewed', value: true },
						{ type: 'check', field: 'tested', value: true },
					],
				},
			],
		};
		const result = evaluateCondition(condition, {
			override: false,
			reviewed: true,
			tested: true,
		});
		expect(result.open).toBe(true);
	});

	test('deeply nested: all > any > all', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{
					type: 'any',
					conditions: [
						{
							type: 'all',
							conditions: [
								{ type: 'check', field: 'a', value: true },
								{ type: 'check', field: 'b', value: true },
							],
						},
						{ type: 'check', field: 'shortcut', value: true },
					],
				},
				{ type: 'check', field: 'final', value: true },
			],
		};
		// a=true, b=true satisfies inner all → any passes; final=true → outer all passes
		expect(
			evaluateCondition(condition, { a: true, b: true, shortcut: false, final: true }).open
		).toBe(true);
		// a=false → inner all fails; shortcut=false → any fails → outer all fails
		expect(
			evaluateCondition(condition, { a: false, b: true, shortcut: false, final: true }).open
		).toBe(false);
	});

	test('mixed ops in composite: exists + count + !=', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'plan', op: 'exists' },
				{ type: 'check', field: 'status', op: '!=', value: 'rejected' },
				{ type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			],
		};
		const result = evaluateCondition(condition, {
			plan: 'my plan',
			status: 'in_review',
			reviews: { alice: 'approved', bob: 'approved' },
		});
		expect(result.open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// evaluateGate (reads from gate.data)
// ---------------------------------------------------------------------------

describe('evaluateGate', () => {
	test('evaluates gate condition against gate.data', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'approved', value: true },
			data: { approved: true },
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate);
		expect(result.open).toBe(true);
	});

	test('blocks when gate.data does not satisfy condition', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'count', field: 'reviews', matchValue: 'approved', min: 2 },
			data: { reviews: { alice: 'approved' } },
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate);
		expect(result.open).toBe(false);
	});

	test('opens with exists op when field present in gate.data', () => {
		const gate: Gate = {
			id: 'gate-plan',
			condition: { type: 'check', field: 'plan', op: 'exists' },
			data: { plan: 'implement feature X' },
			allowedWriterRoles: ['planner'],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate);
		expect(result.open).toBe(true);
	});

	test('blocks with exists op when field missing from gate.data', () => {
		const gate: Gate = {
			id: 'gate-plan',
			condition: { type: 'check', field: 'plan', op: 'exists' },
			data: {},
			allowedWriterRoles: ['planner'],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate);
		expect(result.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isChannelOpen
// ---------------------------------------------------------------------------

describe('isChannelOpen', () => {
	test('channel without gateId is always open', () => {
		const channel: Channel = { id: 'ch-1', from: 'planner', to: 'coder' };
		const result = isChannelOpen(channel, new Map());
		expect(result.open).toBe(true);
	});

	test('channel with gateId opens when gate passes', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'approved', value: true },
			data: { approved: true },
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		const channel: Channel = { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'gate-1' };
		const result = isChannelOpen(channel, new Map([['gate-1', gate]]));
		expect(result.open).toBe(true);
	});

	test('channel with gateId blocks when gate fails', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'approved', value: true },
			data: { approved: false },
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		const channel: Channel = { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'gate-1' };
		const result = isChannelOpen(channel, new Map([['gate-1', gate]]));
		expect(result.open).toBe(false);
	});

	test('channel blocks when referenced gate is not found (misconfiguration)', () => {
		const channel: Channel = {
			id: 'ch-1',
			from: 'coder',
			to: 'reviewer',
			gateId: 'missing-gate',
		};
		const result = isChannelOpen(channel, new Map());
		expect(result.open).toBe(false);
		expect(result.reason).toContain('not found');
		expect(result.reason).toContain('missing-gate');
	});

	test('works with Record<string, Gate> instead of Map', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'ready', value: true },
			data: { ready: true },
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'gate-1' };
		const result = isChannelOpen(channel, { 'gate-1': gate });
		expect(result.open).toBe(true);
	});

	test('works with Record<string, Gate> when gate missing', () => {
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'nope' };
		const result = isChannelOpen(channel, {});
		expect(result.open).toBe(false);
	});

	test('gateless channel with isCyclic flag is still open', () => {
		const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', isCyclic: true };
		const result = isChannelOpen(channel, new Map());
		expect(result.open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Runtime validation — validateGateCondition
// ---------------------------------------------------------------------------

describe('validateGateCondition', () => {
	test('valid check condition (no op) passes', () => {
		const errors = validateGateCondition({ type: 'check', field: 'approved', value: true });
		expect(errors).toEqual([]);
	});

	test('valid check condition with op passes', () => {
		const errors = validateGateCondition({ type: 'check', field: 'plan', op: 'exists' });
		expect(errors).toEqual([]);
	});

	test('valid check condition with == op passes', () => {
		const errors = validateGateCondition({
			type: 'check',
			field: 'x',
			op: '==',
			value: 'hello',
		});
		expect(errors).toEqual([]);
	});

	test('valid check condition with != op passes', () => {
		const errors = validateGateCondition({
			type: 'check',
			field: 'x',
			op: '!=',
			value: 'bad',
		});
		expect(errors).toEqual([]);
	});

	test('rejects check with invalid op', () => {
		const errors = validateGateCondition({
			type: 'check',
			field: 'x',
			op: 'gt',
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('op');
		expect(errors[0]).toContain('exists');
	});

	test('valid count condition passes', () => {
		const errors = validateGateCondition({
			type: 'count',
			field: 'reviews',
			matchValue: 'approved',
			min: 2,
		});
		expect(errors).toEqual([]);
	});

	test('valid all condition passes', () => {
		const errors = validateGateCondition({
			type: 'all',
			conditions: [{ type: 'check', field: 'ok', value: true }],
		});
		expect(errors).toEqual([]);
	});

	test('valid any condition passes', () => {
		const errors = validateGateCondition({
			type: 'any',
			conditions: [{ type: 'count', field: 'x', matchValue: true, min: 1 }],
		});
		expect(errors).toEqual([]);
	});

	test('rejects null', () => {
		const errors = validateGateCondition(null);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected an object');
	});

	test('rejects non-object', () => {
		const errors = validateGateCondition('not an object');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('rejects unknown type', () => {
		const errors = validateGateCondition({ type: 'unknown_type' });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected one of');
	});

	test('rejects check with missing field', () => {
		const errors = validateGateCondition({ type: 'check', value: true });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('field');
	});

	test('rejects count with non-numeric min', () => {
		const errors = validateGateCondition({
			type: 'count',
			field: 'x',
			matchValue: 'a',
			min: 'not a number',
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('min');
	});

	test('rejects all with non-array conditions', () => {
		const errors = validateGateCondition({ type: 'all', conditions: 'not an array' });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('expected array');
	});

	test('validates nested conditions recursively', () => {
		const errors = validateGateCondition({
			type: 'all',
			conditions: [{ type: 'check', value: true }], // missing field
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('conditions[0].field');
	});
});

// ---------------------------------------------------------------------------
// Malformed JSON — runtime fallback for unknown condition type
// ---------------------------------------------------------------------------

describe('evaluateCondition — malformed input', () => {
	test('unknown condition type returns closed with descriptive reason', () => {
		const malformed = { type: 'nonexistent' } as unknown as GateCondition;
		const result = evaluateCondition(malformed, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('unknown condition type');
		expect(result.reason).toContain('nonexistent');
	});
});
