/**
 * Unit tests for task-agent-tool-schemas.ts
 *
 * Verifies that each Zod schema:
 * - Accepts valid inputs (including optional fields present or absent)
 * - Rejects invalid inputs with a ZodError
 */

import { describe, test, expect } from 'bun:test';
import {
	ApproveTaskSchema,
	SubmitForApprovalSchema,
	RequestHumanInputSchema,
	TASK_AGENT_TOOL_SCHEMAS,
	ListGroupMembersSchema,
} from '../../../../src/lib/space/tools/task-agent-tool-schemas.ts';

// ---------------------------------------------------------------------------
// ApproveTaskSchema
// ---------------------------------------------------------------------------

describe('ApproveTaskSchema', () => {
	test('accepts empty object', () => {
		const result = ApproveTaskSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('rejects extra fields (strict schema)', () => {
		const result = ApproveTaskSchema.safeParse({ reason: 'done' });
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SubmitForApprovalSchema
// ---------------------------------------------------------------------------

describe('SubmitForApprovalSchema', () => {
	test('accepts empty object (reason is optional)', () => {
		const result = SubmitForApprovalSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.reason).toBeUndefined();
		}
	});

	test('accepts reason string', () => {
		const result = SubmitForApprovalSchema.safeParse({
			reason: 'Risky change, needs human review',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.reason).toBe('Risky change, needs human review');
		}
	});

	test('rejects non-string reason', () => {
		const result = SubmitForApprovalSchema.safeParse({ reason: 42 });
		expect(result.success).toBe(false);
	});

	test('rejects extra fields (strict schema)', () => {
		const result = SubmitForApprovalSchema.safeParse({ reason: 'ok', extra: 'bad' });
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
		expect(keys).toContain('approve_task');
		expect(keys).toContain('submit_for_approval');
		expect(keys).toContain('request_human_input');
		expect(keys).toContain('list_group_members');
		expect(keys).toContain('merge_pr');
		expect(keys).toHaveLength(5);
	});

	test('each schema value is a valid Zod schema with safeParse', () => {
		for (const schema of Object.values(TASK_AGENT_TOOL_SCHEMAS)) {
			expect(typeof schema.safeParse).toBe('function');
		}
	});

	test('does not contain removed tools', () => {
		const keys = Object.keys(TASK_AGENT_TOOL_SCHEMAS);
		expect(keys).not.toContain('report_result');
		expect(keys).not.toContain('spawn_node_agent');
		expect(keys).not.toContain('check_node_status');
		expect(keys).not.toContain('advance_workflow');
	});
});

// ---------------------------------------------------------------------------
// list_group_members
// ---------------------------------------------------------------------------

describe('ListGroupMembersSchema', () => {
	test('accepts empty object', () => {
		const result = ListGroupMembersSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('accepts object with extra fields (passthrough)', () => {
		// Zod strips extra fields by default — just verify it does not throw
		const result = ListGroupMembersSchema.safeParse({ extra: 'ignored' });
		expect(result.success).toBe(true);
	});
});
