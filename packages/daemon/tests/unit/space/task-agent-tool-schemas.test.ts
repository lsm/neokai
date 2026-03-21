/**
 * Unit tests for task-agent-tool-schemas.ts
 *
 * Verifies that each Zod schema:
 * - Accepts valid inputs (including optional fields present or absent)
 * - Rejects invalid inputs with a ZodError
 */

import { describe, test, expect } from 'bun:test';
import {
	SpawnStepAgentSchema,
	CheckStepStatusSchema,
	AdvanceWorkflowSchema,
	ReportResultSchema,
	RequestHumanInputSchema,
	TASK_AGENT_TOOL_SCHEMAS,
} from '../../../src/lib/space/tools/task-agent-tool-schemas.ts';

// ---------------------------------------------------------------------------
// spawn_step_agent
// ---------------------------------------------------------------------------

describe('SpawnStepAgentSchema', () => {
	test('accepts valid input with step_id only', () => {
		const result = SpawnStepAgentSchema.safeParse({ step_id: 'step-abc' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.step_id).toBe('step-abc');
			expect(result.data.instructions).toBeUndefined();
		}
	});

	test('accepts valid input with step_id and instructions', () => {
		const result = SpawnStepAgentSchema.safeParse({
			step_id: 'step-abc',
			instructions: 'Focus on unit tests only',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.instructions).toBe('Focus on unit tests only');
		}
	});

	test('rejects missing step_id', () => {
		const result = SpawnStepAgentSchema.safeParse({ instructions: 'some instructions' });
		expect(result.success).toBe(false);
	});

	test('rejects non-string step_id', () => {
		const result = SpawnStepAgentSchema.safeParse({ step_id: 42 });
		expect(result.success).toBe(false);
	});

	test('rejects non-string instructions', () => {
		const result = SpawnStepAgentSchema.safeParse({ step_id: 'step-1', instructions: 123 });
		expect(result.success).toBe(false);
	});

	test('rejects empty object', () => {
		const result = SpawnStepAgentSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// check_step_status
// ---------------------------------------------------------------------------

describe('CheckStepStatusSchema', () => {
	test('accepts empty object (check current active step)', () => {
		const result = CheckStepStatusSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.step_id).toBeUndefined();
		}
	});

	test('accepts valid input with step_id', () => {
		const result = CheckStepStatusSchema.safeParse({ step_id: 'step-xyz' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.step_id).toBe('step-xyz');
		}
	});

	test('rejects non-string step_id', () => {
		const result = CheckStepStatusSchema.safeParse({ step_id: true });
		expect(result.success).toBe(false);
	});

	test('rejects null step_id', () => {
		const result = CheckStepStatusSchema.safeParse({ step_id: null });
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// advance_workflow
// ---------------------------------------------------------------------------

describe('AdvanceWorkflowSchema', () => {
	test('accepts empty object (no step_result)', () => {
		const result = AdvanceWorkflowSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.step_result).toBeUndefined();
		}
	});

	test('accepts valid input with step_result', () => {
		const result = AdvanceWorkflowSchema.safeParse({ step_result: 'All tests passed.' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.step_result).toBe('All tests passed.');
		}
	});

	test('rejects non-string step_result', () => {
		const result = AdvanceWorkflowSchema.safeParse({ step_result: 42 });
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// report_result
// ---------------------------------------------------------------------------

describe('ReportResultSchema', () => {
	test('accepts completed status with summary', () => {
		const result = ReportResultSchema.safeParse({ status: 'completed', summary: 'Task done.' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.status).toBe('completed');
			expect(result.data.error).toBeUndefined();
		}
	});

	test('accepts needs_attention status with summary and error', () => {
		const result = ReportResultSchema.safeParse({
			status: 'needs_attention',
			summary: 'Blocked on auth issue.',
			error: 'OAuth token expired',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.status).toBe('needs_attention');
			expect(result.data.error).toBe('OAuth token expired');
		}
	});

	test('accepts cancelled status', () => {
		const result = ReportResultSchema.safeParse({
			status: 'cancelled',
			summary: 'User cancelled the task.',
		});
		expect(result.success).toBe(true);
	});

	test('rejects invalid status value', () => {
		const result = ReportResultSchema.safeParse({ status: 'failed', summary: 'Bad.' });
		expect(result.success).toBe(false);
	});

	test('rejects missing status', () => {
		const result = ReportResultSchema.safeParse({ summary: 'Done.' });
		expect(result.success).toBe(false);
	});

	test('rejects missing summary', () => {
		const result = ReportResultSchema.safeParse({ status: 'completed' });
		expect(result.success).toBe(false);
	});

	test('rejects empty object', () => {
		const result = ReportResultSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test('rejects non-string summary', () => {
		const result = ReportResultSchema.safeParse({ status: 'completed', summary: 99 });
		expect(result.success).toBe(false);
	});

	test('rejects non-string error', () => {
		const result = ReportResultSchema.safeParse({
			status: 'cancelled',
			summary: 'done',
			error: { message: 'oops' },
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// request_human_input
// ---------------------------------------------------------------------------

describe('RequestHumanInputSchema', () => {
	test('accepts valid input with question only', () => {
		const result = RequestHumanInputSchema.safeParse({ question: 'Should I proceed?' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.question).toBe('Should I proceed?');
			expect(result.data.context).toBeUndefined();
		}
	});

	test('accepts valid input with question and context', () => {
		const result = RequestHumanInputSchema.safeParse({
			question: 'Which environment should I deploy to?',
			context: 'The staging build passed all tests.',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.context).toBe('The staging build passed all tests.');
		}
	});

	test('rejects missing question', () => {
		const result = RequestHumanInputSchema.safeParse({ context: 'some context' });
		expect(result.success).toBe(false);
	});

	test('rejects non-string question', () => {
		const result = RequestHumanInputSchema.safeParse({ question: 123 });
		expect(result.success).toBe(false);
	});

	test('rejects non-string context', () => {
		const result = RequestHumanInputSchema.safeParse({ question: 'ok?', context: false });
		expect(result.success).toBe(false);
	});

	test('rejects empty object', () => {
		const result = RequestHumanInputSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// TASK_AGENT_TOOL_SCHEMAS aggregate
// ---------------------------------------------------------------------------

describe('TASK_AGENT_TOOL_SCHEMAS', () => {
	test('contains all 5 tool schemas', () => {
		const keys = Object.keys(TASK_AGENT_TOOL_SCHEMAS);
		expect(keys).toContain('spawn_step_agent');
		expect(keys).toContain('check_step_status');
		expect(keys).toContain('advance_workflow');
		expect(keys).toContain('report_result');
		expect(keys).toContain('request_human_input');
		expect(keys).toHaveLength(5);
	});

	test('each schema value is a valid Zod schema with safeParse', () => {
		for (const schema of Object.values(TASK_AGENT_TOOL_SCHEMAS)) {
			expect(typeof schema.safeParse).toBe('function');
		}
	});
});
