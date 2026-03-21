/**
 * Unit tests for buildSpaceChatSystemPrompt()
 *
 * Verifies:
 * - Prompt includes available workflow names, descriptions, and tags
 * - Prompt includes available agent names and roles
 * - Guidance text for start_workflow_run vs create_standalone_task is present
 * - Operator-supplied background and instructions are included
 * - Empty workflows/agents handled gracefully
 * - Event handling section always included with all four event kinds
 * - Autonomy level section reflects configured level
 * - Escalation section always included
 * - Coordination tools section always included
 */

import { describe, test, expect } from 'bun:test';
import {
	buildSpaceChatSystemPrompt,
	type SpaceChatAgentContext,
	type WorkflowSummary,
	type AgentSummary,
} from '../../../src/lib/space/agents/space-chat-agent';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkflow(overrides?: Partial<WorkflowSummary>): WorkflowSummary {
	return {
		id: 'wf-1',
		name: 'Coding Workflow',
		description: 'Plan, code, and review',
		tags: ['coding', 'review'],
		stepCount: 3,
		...overrides,
	};
}

function makeAgent(overrides?: Partial<AgentSummary>): AgentSummary {
	return {
		id: 'agent-1',
		name: 'Coder',
		role: 'coder',
		description: 'Implementation specialist',
		...overrides,
	};
}

function makeContext(overrides?: Partial<SpaceChatAgentContext>): SpaceChatAgentContext {
	return {
		workflows: [makeWorkflow()],
		agents: [makeAgent()],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — basic structure', () => {
	test('returns non-empty string', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	test('identifies agent as Space Agent coordinator', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Space Agent');
	});

	test('no context produces minimal prompt without errors', () => {
		expect(() => buildSpaceChatSystemPrompt()).not.toThrow();
		expect(() => buildSpaceChatSystemPrompt({})).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Workflow information
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — workflow information', () => {
	test('includes workflow name', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('Coding Workflow');
	});

	test('includes workflow description', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('Plan, code, and review');
	});

	test('includes workflow tags', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('coding');
		expect(prompt).toContain('review');
	});

	test('includes workflow id', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('wf-1');
	});

	test('includes step count', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('3 step');
	});

	test('includes multiple workflows', () => {
		const ctx = makeContext({
			workflows: [
				makeWorkflow({ id: 'wf-1', name: 'Alpha Workflow' }),
				makeWorkflow({ id: 'wf-2', name: 'Beta Workflow' }),
			],
		});
		const prompt = buildSpaceChatSystemPrompt(ctx);
		expect(prompt).toContain('Alpha Workflow');
		expect(prompt).toContain('Beta Workflow');
	});

	test('handles workflow with no description', () => {
		const ctx = makeContext({
			workflows: [makeWorkflow({ description: undefined })],
		});
		const prompt = buildSpaceChatSystemPrompt(ctx);
		expect(prompt).toContain('Coding Workflow');
	});

	test('handles workflow with no tags', () => {
		const ctx = makeContext({
			workflows: [makeWorkflow({ tags: [] })],
		});
		const prompt = buildSpaceChatSystemPrompt(ctx);
		expect(prompt).toContain('Coding Workflow');
	});

	test('shows message when no workflows configured', () => {
		const prompt = buildSpaceChatSystemPrompt({ workflows: [] });
		expect(prompt).toContain('No workflows are currently configured');
	});

	test('shows message when workflows is undefined', () => {
		const prompt = buildSpaceChatSystemPrompt({});
		expect(prompt).toContain('No workflows are currently configured');
	});
});

// ---------------------------------------------------------------------------
// Agent information
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — agent information', () => {
	test('includes agent name', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('Coder');
	});

	test('includes agent role', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('coder');
	});

	test('includes agent description', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('Implementation specialist');
	});

	test('includes multiple agents', () => {
		const ctx = makeContext({
			agents: [
				makeAgent({ name: 'Coder', role: 'coder' }),
				makeAgent({ id: 'agent-2', name: 'Reviewer', role: 'reviewer' }),
			],
		});
		const prompt = buildSpaceChatSystemPrompt(ctx);
		expect(prompt).toContain('Coder');
		expect(prompt).toContain('Reviewer');
	});

	test('handles agent with no description', () => {
		const ctx = makeContext({
			agents: [makeAgent({ description: undefined })],
		});
		const prompt = buildSpaceChatSystemPrompt(ctx);
		expect(prompt).toContain('Coder');
	});
});

// ---------------------------------------------------------------------------
// Workflow vs task guidance
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — workflow vs task guidance', () => {
	test('includes start_workflow_run guidance', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('start_workflow_run');
	});

	test('includes create_standalone_task guidance', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('create_standalone_task');
	});

	test('mentions list_workflows discovery tool', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('list_workflows');
	});

	test('mentions suggest_workflow discovery tool', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('suggest_workflow');
	});

	test('mentions get_workflow_detail tool', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('get_workflow_detail');
	});

	test('includes guidance not to create tasks immediately', () => {
		const prompt = buildSpaceChatSystemPrompt(makeContext());
		expect(prompt).toContain('Never create tasks immediately');
	});
});

// ---------------------------------------------------------------------------
// Operator-supplied context
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — operator context', () => {
	test('includes background context when provided', () => {
		const prompt = buildSpaceChatSystemPrompt({
			background: 'This is a payments platform.',
		});
		expect(prompt).toContain('This is a payments platform.');
	});

	test('includes instructions when provided', () => {
		const prompt = buildSpaceChatSystemPrompt({
			instructions: 'Always open PRs against the dev branch.',
		});
		expect(prompt).toContain('Always open PRs against the dev branch.');
	});

	test('omits background section when not provided', () => {
		const prompt = buildSpaceChatSystemPrompt({});
		expect(prompt).not.toContain('Space Background');
	});

	test('omits instructions section when not provided', () => {
		const prompt = buildSpaceChatSystemPrompt({});
		expect(prompt).not.toContain('Space Instructions');
	});
});

// ---------------------------------------------------------------------------
// Event handling section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — event handling', () => {
	test('includes Event Handling section header', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Event Handling');
	});

	test('includes [TASK_EVENT] prefix description', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('[TASK_EVENT]');
	});

	test('includes task_needs_attention event kind', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('task_needs_attention');
	});

	test('includes workflow_run_needs_attention event kind', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('workflow_run_needs_attention');
	});

	test('includes task_timeout event kind', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('task_timeout');
	});

	test('includes workflow_run_completed event kind', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('workflow_run_completed');
	});

	test('event handling section present regardless of autonomy level', () => {
		const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		const empty = buildSpaceChatSystemPrompt({});
		for (const prompt of [supervised, semi, empty]) {
			expect(prompt).toContain('task_needs_attention');
			expect(prompt).toContain('workflow_run_completed');
		}
	});
});

// ---------------------------------------------------------------------------
// Autonomy level section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — autonomy level', () => {
	test('includes Autonomy Level section header', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Autonomy Level');
	});

	test('defaults to supervised mode when autonomyLevel is not set', () => {
		const prompt = buildSpaceChatSystemPrompt({});
		expect(prompt).toContain('supervised');
		expect(prompt).toContain('wait for human approval');
	});

	test('supervised mode includes notify-human instruction', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('Notify the human');
	});

	test('supervised mode includes wait for approval instruction', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('wait for human approval');
	});

	test('supervised mode forbids autonomous retry/reassign/cancel', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('Do not call `retry_task`');
	});

	test('semi_autonomous mode shows the configured level', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('semi_autonomous');
	});

	test('semi_autonomous mode allows autonomous retry', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Retry a failed task once');
	});

	test('semi_autonomous mode allows reassign', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Reassign a task');
	});

	test('semi_autonomous mode says escalate after one failed retry', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('one failed retry');
	});

	test('semi_autonomous mode still enforces human-gated steps', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Human-gated workflow steps always require human approval');
	});

	test('supervised and semi_autonomous produce different autonomy instructions', () => {
		const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(supervised).not.toEqual(semi);
		expect(supervised).toContain('wait for human approval');
		expect(semi).toContain('Retry a failed task once');
	});
});

// ---------------------------------------------------------------------------
// Escalation section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — escalation', () => {
	test('includes Escalation section header', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Escalation');
	});

	test('includes "What happened" escalation step', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('What happened');
	});

	test('includes "What was considered" escalation step', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('What was considered');
	});

	test('includes "What is recommended" escalation step', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('What is recommended');
	});

	test('includes "Clear question" escalation step', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Clear question');
	});

	test('escalation section present regardless of autonomy level', () => {
		const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		for (const prompt of [supervised, semi]) {
			expect(prompt).toContain('Escalation');
			expect(prompt).toContain('What happened');
		}
	});
});

// ---------------------------------------------------------------------------
// Coordination tools section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — coordination tools', () => {
	test('includes Coordination Tools section header', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Coordination Tools');
	});

	test('documents create_standalone_task tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		// At least two occurrences: Decision Guide and Coordination Tools
		const count = (prompt.match(/create_standalone_task/g) ?? []).length;
		expect(count).toBeGreaterThanOrEqual(2);
	});

	test('documents get_task_detail tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('get_task_detail');
	});

	test('documents retry_task tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('retry_task');
	});

	test('documents cancel_task tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('cancel_task');
	});

	test('documents reassign_task tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('reassign_task');
	});

	test('documents send_message_to_task tool', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('send_message_to_task');
	});

	test('coordination tools section present for all autonomy levels', () => {
		const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		for (const prompt of [supervised, semi]) {
			expect(prompt).toContain('get_task_detail');
			expect(prompt).toContain('retry_task');
		}
	});
});
