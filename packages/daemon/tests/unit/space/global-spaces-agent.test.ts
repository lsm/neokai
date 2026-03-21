/**
 * Unit tests for buildGlobalSpacesAgentPrompt()
 *
 * Verifies:
 * - Basic structure and role identification
 * - Capabilities section lists cross-space and per-space tools
 * - Task Coordination section lists all coordination tools
 * - Decision tree guidance is present for retry/cancel/reassign
 * - Autonomy level guidance is present for supervised and semi_autonomous
 * - Guidelines section is present
 */

import { describe, test, expect } from 'bun:test';
import { buildGlobalSpacesAgentPrompt } from '../../../src/lib/space/agents/global-spaces-agent';

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — basic structure', () => {
	test('returns non-empty string', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	test('identifies agent as Spaces Agent', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Spaces Agent');
	});

	test('does not throw', () => {
		expect(() => buildGlobalSpacesAgentPrompt()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Capabilities section
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — capabilities', () => {
	test('includes cross-space operations heading', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Cross-space operations');
	});

	test('includes per-space operations heading', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Per-space operations');
	});

	test('mentions workflow management', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('workflows');
	});

	test('mentions task management', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('tasks');
	});
});

// ---------------------------------------------------------------------------
// Task Coordination section — tool listing
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — task coordination tools', () => {
	test('includes Task Coordination section header', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Task Coordination');
	});

	test('lists create_standalone_task tool', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('create_standalone_task');
	});

	test('lists get_task_detail tool', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('get_task_detail');
	});

	test('lists retry_task tool', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('retry_task');
	});

	test('lists cancel_task tool', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('cancel_task');
	});

	test('lists reassign_task tool', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('reassign_task');
	});

	test('explains create_standalone_task purpose', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('outside any workflow');
	});

	test('explains get_task_detail purpose', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('error information');
	});

	test('explains retry_task purpose', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('needs_attention');
	});
});

// ---------------------------------------------------------------------------
// Decision tree guidance
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — decision tree', () => {
	test('includes decision tree section', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Decision Guide');
	});

	test('instructs to get context first via get_task_detail', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Get the full context first');
	});

	test('includes Retry guidance', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Retry');
		expect(prompt).toContain('transient');
	});

	test('includes Reassign guidance', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Reassign');
		expect(prompt).toContain('specialist');
	});

	test('includes Cancel guidance', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Cancel');
		expect(prompt).toContain('unrecoverable');
	});

	test('includes escalate to human guidance', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Escalate to human');
	});

	test('notes to escalate when uncertain', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('uncertain');
	});
});

// ---------------------------------------------------------------------------
// Autonomy levels section
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — autonomy levels', () => {
	test('includes Autonomy Levels section header', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Autonomy Levels');
	});

	test('describes supervised autonomy level', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('supervised');
		expect(prompt).toContain('wait for explicit human approval');
	});

	test('describes semi_autonomous autonomy level', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('semi_autonomous');
		expect(prompt).toContain('autonomously');
	});

	test('notes supervised is the default', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('default');
	});

	test('instructs to check autonomy level via get_space', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('get_space');
	});

	test('notes human gates always require human input', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Human gates');
	});
});

// ---------------------------------------------------------------------------
// Guidelines section
// ---------------------------------------------------------------------------

describe('buildGlobalSpacesAgentPrompt — guidelines', () => {
	test('includes Guidelines section', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('Guidelines');
	});

	test('instructs to confirm destructive operations', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		expect(prompt).toContain('delete_space');
		expect(prompt).toContain('archive_space');
	});

	test('instructs to call get_task_detail before coordination actions', () => {
		const prompt = buildGlobalSpacesAgentPrompt();
		// The guideline says to call get_task_detail first for task events
		expect(prompt).toContain('get_task_detail first');
	});
});
