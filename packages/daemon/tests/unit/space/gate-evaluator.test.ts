/**
 * GateEvaluator Unit Tests
 *
 * Covers all 4 GateCondition types:
 *   check — field equality: data[field] === value
 *   count — numeric threshold: data[field] >= threshold
 *   all   — composite AND (recursive, short-circuits on failure)
 *   any   — composite OR (recursive, short-circuits on success)
 *
 * Also covers:
 *   - evaluateGate: gate-level evaluation with data store
 *   - Edge cases: missing fields, zero values, nested composites
 */

import { describe, test, expect } from 'bun:test';
import { evaluateGate, evaluateCondition } from '../../../src/lib/space/runtime/gate-evaluator.ts';
import type { Gate, GateCondition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// check condition
// ---------------------------------------------------------------------------

describe('GateEvaluator — check condition', () => {
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
});

// ---------------------------------------------------------------------------
// count condition
// ---------------------------------------------------------------------------

describe('GateEvaluator — count condition', () => {
	test('opens when field >= threshold', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 2 };
		const result = evaluateCondition(condition, { approvals: 3 });
		expect(result.open).toBe(true);
	});

	test('opens when field equals threshold exactly', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 2 };
		const result = evaluateCondition(condition, { approvals: 2 });
		expect(result.open).toBe(true);
	});

	test('blocks when field < threshold', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 2 };
		const result = evaluateCondition(condition, { approvals: 1 });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('1');
		expect(result.reason).toContain('>= 2');
	});

	test('treats missing field as 0', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 1 };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
		expect(result.reason).toContain('0');
	});

	test('treats non-numeric field as 0', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 1 };
		const result = evaluateCondition(condition, { approvals: 'not a number' });
		expect(result.open).toBe(false);
	});

	test('opens with threshold of 0 when field is missing', () => {
		const condition: GateCondition = { type: 'count', field: 'approvals', threshold: 0 };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(true);
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
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: true, reviews: 3 });
		expect(result.open).toBe(true);
	});

	test('blocks when first sub-condition fails (short-circuit)', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: false, reviews: 3 });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('approved');
	});

	test('blocks when second sub-condition fails', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: true, reviews: 1 });
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
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: true, reviews: 0 });
		expect(result.open).toBe(true);
	});

	test('opens when second sub-condition passes', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: false, reviews: 3 });
		expect(result.open).toBe(true);
	});

	test('blocks when all sub-conditions fail', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const result = evaluateCondition(condition, { approved: false, reviews: 1 });
		expect(result.open).toBe(false);
		expect(result.reason).toContain('None of the conditions passed');
	});

	test('blocks with empty conditions list', () => {
		const condition: GateCondition = { type: 'any', conditions: [] };
		const result = evaluateCondition(condition, {});
		expect(result.open).toBe(false);
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
						{ type: 'count', field: 'approvals', threshold: 2 },
					],
				},
				{ type: 'check', field: 'tests_passed', value: true },
			],
		};
		// fast_track is true (any passes), tests_passed is true (all passes)
		const result = evaluateCondition(condition, {
			fast_track: true,
			approvals: 0,
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
		// override is false, but reviewed+tested both true
		const result = evaluateCondition(condition, {
			override: false,
			reviewed: true,
			tested: true,
		});
		expect(result.open).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// evaluateGate (top-level)
// ---------------------------------------------------------------------------

describe('evaluateGate', () => {
	test('evaluates gate condition against provided data', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'approved', value: true },
			data: { approved: false },
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: false,
		};
		// Gate data says approved is true → gate opens
		const result = evaluateGate(gate, { approved: true });
		expect(result.open).toBe(true);
	});

	test('blocks when gate data does not satisfy condition', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'count', field: 'approvals', threshold: 2 },
			data: {},
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate, { approvals: 1 });
		expect(result.open).toBe(false);
	});
});
