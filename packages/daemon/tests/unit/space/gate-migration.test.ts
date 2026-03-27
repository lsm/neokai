/**
 * Gate Migration Utility Tests
 *
 * Covers migration of legacy WorkflowCondition types to the separated Gate format:
 *   always      → no gate (channel always open)
 *   human       → check approved === true
 *   condition   → check result === true (expression preserved in description)
 *   task_result → check result === expression value
 *   undefined   → no gate
 */

import { describe, test, expect } from 'bun:test';
import { migrateLegacyCondition } from '@neokai/shared';
import type { WorkflowCondition } from '@neokai/shared';

describe('migrateLegacyCondition', () => {
	test('undefined condition → no gate', () => {
		const result = migrateLegacyCondition(undefined, 'gate-1');
		expect(result.gate).toBeNull();
		expect(result.gateId).toBeUndefined();
	});

	test('always → no gate (channel is gateless)', () => {
		const condition: WorkflowCondition = { type: 'always' };
		const result = migrateLegacyCondition(condition, 'gate-1');
		expect(result.gate).toBeNull();
		expect(result.gateId).toBeUndefined();
	});

	test('human → check gate with approved field', () => {
		const condition: WorkflowCondition = {
			type: 'human',
			description: 'Requires human approval',
		};
		const result = migrateLegacyCondition(condition, 'gate-human-1');

		expect(result.gate).not.toBeNull();
		expect(result.gateId).toBe('gate-human-1');

		const gate = result.gate!;
		expect(gate.id).toBe('gate-human-1');
		expect(gate.condition.type).toBe('check');
		if (gate.condition.type === 'check') {
			expect(gate.condition.field).toBe('approved');
			expect(gate.condition.value).toBe(true);
		}
		expect(gate.data).toEqual({ approved: false });
		expect(gate.allowedWriterRoles).toEqual(['*']);
		expect(gate.resetOnCycle).toBe(false);
		expect(gate.description).toBe('Requires human approval');
	});

	test('human without description gets default description', () => {
		const condition: WorkflowCondition = { type: 'human' };
		const result = migrateLegacyCondition(condition, 'gate-1');

		expect(result.gate!.description).toContain('migrated from legacy');
	});

	test('condition → check gate with result field', () => {
		const condition: WorkflowCondition = {
			type: 'condition',
			expression: 'test -f /tmp/ready',
			description: 'File exists check',
		};
		const result = migrateLegacyCondition(condition, 'gate-cond-1');

		expect(result.gate).not.toBeNull();
		expect(result.gateId).toBe('gate-cond-1');

		const gate = result.gate!;
		expect(gate.condition.type).toBe('check');
		if (gate.condition.type === 'check') {
			expect(gate.condition.field).toBe('result');
			expect(gate.condition.value).toBe(true);
		}
		expect(gate.data).toEqual({ result: false });
		expect(gate.description).toBe('File exists check');
	});

	test('condition without description preserves original expression in description', () => {
		const condition: WorkflowCondition = {
			type: 'condition',
			expression: 'echo hello',
		};
		const result = migrateLegacyCondition(condition, 'gate-1');

		expect(result.gate!.description).toContain('echo hello');
	});

	test('task_result → check gate with result field matching expression', () => {
		const condition: WorkflowCondition = {
			type: 'task_result',
			expression: 'passed',
			description: 'Task must pass',
		};
		const result = migrateLegacyCondition(condition, 'gate-task-1');

		expect(result.gate).not.toBeNull();
		expect(result.gateId).toBe('gate-task-1');

		const gate = result.gate!;
		expect(gate.condition.type).toBe('check');
		if (gate.condition.type === 'check') {
			expect(gate.condition.field).toBe('result');
			expect(gate.condition.value).toBe('passed');
		}
		expect(gate.data).toEqual({});
		expect(gate.description).toBe('Task must pass');
	});

	test('task_result without expression defaults to "passed"', () => {
		const condition: WorkflowCondition = { type: 'task_result' };
		const result = migrateLegacyCondition(condition, 'gate-1');

		const gate = result.gate!;
		if (gate.condition.type === 'check') {
			expect(gate.condition.value).toBe('passed');
		}
	});
});
