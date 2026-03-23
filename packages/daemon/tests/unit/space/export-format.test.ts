/**
 * Export Format Unit Tests
 *
 * Covers:
 * - exportAgent: strips space-specific fields, maps agent.tools (string[]) → exported.tools
 * - exportWorkflow: strips step IDs, remaps step agentId UUID → agent name (agentRef),
 *   remaps transition from/to step UUIDs → step names, remaps startStepId UUID → step name,
 *   remaps rule appliesTo step UUIDs → step names
 * - exportBundle: wraps agents + workflows, adds exportedAt
 * - validateExportedAgent: accepts v1, rejects malformed, version checks
 * - validateExportedWorkflow: accepts v1, rejects malformed, version checks, transitions/startStep
 * - validateExportBundle: accepts v1, nested agent/workflow validation
 * - Round-trip: export → JSON serialize → deserialize → validate
 * - rule appliesTo round-trip: verify step names in JSON, verify on re-import
 */

import { describe, test, expect } from 'bun:test';
import {
	exportAgent,
	exportWorkflow,
	exportBundle,
	validateExportedAgent,
	validateExportedWorkflow,
	validateExportBundle,
} from '../../../src/lib/space/export-format.ts';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-uuid-1',
		spaceId: 'space-uuid-1',
		name: 'My Coder',
		role: 'coder',
		description: 'Writes code',
		model: 'claude-sonnet-4-6',
		provider: 'anthropic',
		systemPrompt: 'You are an expert coder.',
		tools: ['bash', 'read_file'],
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeMinimalAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-uuid-2',
		spaceId: 'space-uuid-1',
		name: 'Simple Agent',
		role: 'general',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeReviewerAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-uuid-3',
		spaceId: 'space-uuid-1',
		name: 'Reviewer',
		role: 'reviewer',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'workflow-uuid-1',
		spaceId: 'space-uuid-1',
		name: 'CI Workflow',
		description: 'Runs CI pipeline',
		steps: [
			{ id: 'step-uuid-1', agentId: 'agent-uuid-1', name: 'Code step' },
			{
				id: 'step-uuid-2',
				agentId: 'agent-uuid-3',
				name: 'Review step',
				instructions: 'Review carefully',
			},
			{ id: 'step-uuid-3', agentId: 'agent-uuid-2', name: 'Plan step' },
		],
		transitions: [
			{ id: 'trans-uuid-1', from: 'step-uuid-1', to: 'step-uuid-2' },
			{
				id: 'trans-uuid-2',
				from: 'step-uuid-2',
				to: 'step-uuid-3',
				condition: { type: 'human' },
				order: 0,
			},
		],
		startStepId: 'step-uuid-1',
		rules: [
			{
				id: 'rule-uuid-1',
				name: 'All tests must pass',
				content: 'Run `bun test` before completing each step.',
				appliesTo: ['step-uuid-1', 'step-uuid-2'],
			},
			{
				id: 'rule-uuid-2',
				name: 'Global rule',
				content: 'Always follow coding conventions.',
				appliesTo: [],
			},
		],
		tags: ['ci', 'test'],
		config: { maxRuntime: 3600 },
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// exportAgent
// ---------------------------------------------------------------------------

describe('exportAgent', () => {
	test('exports all fields correctly', () => {
		const agent = makeAgent();
		const exported = exportAgent(agent);

		expect(exported.version).toBe(1);
		expect(exported.type).toBe('agent');
		expect(exported.name).toBe('My Coder');
		expect(exported.role).toBe('coder');
		expect(exported.description).toBe('Writes code');
		expect(exported.model).toBe('claude-sonnet-4-6');
		expect(exported.provider).toBe('anthropic');
		expect(exported.systemPrompt).toBe('You are an expert coder.');
		expect(exported.tools).toEqual(['bash', 'read_file']);
	});

	test('strips space-specific fields (id, spaceId, createdAt, updatedAt)', () => {
		const agent = makeAgent();
		const exported = exportAgent(agent) as Record<string, unknown>;

		expect('id' in exported).toBe(false);
		expect('spaceId' in exported).toBe(false);
		expect('createdAt' in exported).toBe(false);
		expect('updatedAt' in exported).toBe(false);
	});

	test('omits undefined optional fields', () => {
		const agent = makeMinimalAgent();
		const exported = exportAgent(agent) as Record<string, unknown>;

		expect('description' in exported).toBe(false);
		expect('model' in exported).toBe(false);
		expect('provider' in exported).toBe(false);
		expect('systemPrompt' in exported).toBe(false);
		expect('tools' in exported).toBe(false);
	});

	test('exports tools as string array', () => {
		const agent = makeAgent({ tools: ['edit_file', 'bash'] });
		const exported = exportAgent(agent);
		expect(exported.tools).toEqual(['edit_file', 'bash']);
	});

	test('exports reviewer role', () => {
		const agent = makeReviewerAgent();
		const exported = exportAgent(agent);
		expect(exported.role).toBe('reviewer');
	});

	test('does not export toolConfig (runtime-only field)', () => {
		const agent = makeAgent({ toolConfig: { foo: true } });
		const exported = exportAgent(agent) as Record<string, unknown>;
		expect('toolConfig' in exported).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// exportWorkflow
// ---------------------------------------------------------------------------

describe('exportWorkflow', () => {
	test('strips workflow-level space fields', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents) as Record<string, unknown>;

		expect('id' in exported).toBe(false);
		expect('spaceId' in exported).toBe(false);
		expect('createdAt' in exported).toBe(false);
		expect('updatedAt' in exported).toBe(false);
	});

	test('strips step IDs', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		for (const step of exported.nodes) {
			expect('id' in step).toBe(false);
		}
	});

	test('strips agentId from steps', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		for (const step of exported.nodes) {
			expect('agentId' in step).toBe(false);
		}
	});

	test('retains step name and instructions', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		expect(exported.nodes[0].name).toBe('Code step');
		expect(exported.nodes[1].name).toBe('Review step');
		expect(exported.nodes[1].instructions).toBe('Review carefully');
		expect(exported.nodes[2].name).toBe('Plan step');
	});

	test('remaps agentId UUID → agent name as agentRef', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		// step 0: agent-uuid-1 → 'My Coder'
		expect(exported.nodes[0].agentRef).toBe('My Coder');
		// step 1: agent-uuid-3 → 'Reviewer'
		expect(exported.nodes[1].agentRef).toBe('Reviewer');
		// step 2: agent-uuid-2 → 'Simple Agent'
		expect(exported.nodes[2].agentRef).toBe('Simple Agent');
	});

	test('falls back to UUID when agent not found', () => {
		const workflow = makeWorkflow();
		// Pass no agents — all agentId refs should fall back to UUID
		const exported = exportWorkflow(workflow, []);

		expect(exported.nodes[0].agentRef).toBe('agent-uuid-1');
		expect(exported.nodes[1].agentRef).toBe('agent-uuid-3');
		expect(exported.nodes[2].agentRef).toBe('agent-uuid-2');
	});

	test('exports transitions with step names replacing UUIDs', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		expect(exported.transitions).toHaveLength(2);
		expect(exported.transitions[0].fromNode).toBe('Code step');
		expect(exported.transitions[0].toNode).toBe('Review step');
		expect(exported.transitions[1].fromNode).toBe('Review step');
		expect(exported.transitions[1].toNode).toBe('Plan step');
		expect(exported.transitions[1].condition).toEqual({ type: 'human' });
		expect(exported.transitions[1].order).toBe(0);
	});

	test('strips transition IDs', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);
		for (const t of exported.transitions) {
			expect('id' in t).toBe(false);
		}
	});

	test('falls back to UUID when transition step not found', () => {
		const workflow = makeWorkflow({
			transitions: [{ id: 'trans-uuid-1', from: 'step-uuid-UNKNOWN', to: 'step-uuid-1' }],
		});
		const exported = exportWorkflow(workflow, []);
		expect(exported.transitions[0].fromNode).toBe('step-uuid-UNKNOWN');
		expect(exported.transitions[0].toNode).toBe('Code step');
	});

	test('exports startStep as step name', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);
		expect(exported.startNode).toBe('Code step');
	});

	test('falls back to UUID for startStep when not found', () => {
		const workflow = makeWorkflow({ startStepId: 'step-uuid-MISSING' });
		const exported = exportWorkflow(workflow, []);
		expect(exported.startNode).toBe('step-uuid-MISSING');
	});

	test('remaps rule appliesTo step UUIDs → step names', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		// rule 0: appliesTo step-uuid-1 and step-uuid-2 → names
		expect(exported.rules[0].appliesTo).toEqual(['Code step', 'Review step']);
	});

	test('omits appliesTo for rule with empty appliesTo array', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		// rule 1: appliesTo is []
		expect(exported.rules[1].appliesTo).toBeUndefined();
	});

	test('partial appliesTo resolution — keeps resolved subset, drops stale UUIDs', () => {
		const workflow = makeWorkflow({
			steps: [
				{ id: 'step-uuid-1', agentId: 'agent-uuid-1', name: 'Step A' },
				{ id: 'step-uuid-2', agentId: 'agent-uuid-2', name: 'Step B' },
			],
			transitions: [],
			startStepId: 'step-uuid-1',
			rules: [
				{
					id: 'rule-uuid-1',
					name: 'Partial rule',
					content: 'One valid, one stale.',
					appliesTo: ['step-uuid-1', 'step-uuid-STALE'],
				},
			],
		});
		const exported = exportWorkflow(workflow, []);

		// Only the resolved name 'Step A' appears; stale UUID is dropped
		expect(exported.rules[0].appliesTo).toEqual(['Step A']);
	});

	test('all-stale appliesTo → appliesTo omitted (rule becomes global)', () => {
		const workflow = makeWorkflow({
			steps: [{ id: 'step-uuid-1', agentId: 'agent-uuid-1', name: 'Step A' }],
			transitions: [],
			startStepId: 'step-uuid-1',
			rules: [
				{
					id: 'rule-uuid-1',
					name: 'Stale rule',
					content: 'All refs are stale.',
					appliesTo: ['step-uuid-STALE-1', 'step-uuid-STALE-2'],
				},
			],
		});
		const exported = exportWorkflow(workflow, []);

		// All UUIDs unresolvable → omitted (rule applies to all steps)
		expect(exported.rules[0].appliesTo).toBeUndefined();
	});

	test('strips rule IDs', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);

		for (const rule of exported.rules) {
			expect('id' in rule).toBe(false);
		}
	});

	test('preserves tags and config', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);

		expect(exported.tags).toEqual(['ci', 'test']);
		expect(exported.config).toEqual({ maxRuntime: 3600 });
	});

	test('has version 1 and type workflow', () => {
		const exported = exportWorkflow(makeWorkflow(), []);
		expect(exported.version).toBe(1);
		expect(exported.type).toBe('workflow');
	});

	test('includes isCyclic in exported transitions', () => {
		const workflow = makeWorkflow({
			steps: [
				{ id: 'step-uuid-1', agentId: 'agent-uuid-1', name: 'Step A' },
				{ id: 'step-uuid-2', agentId: 'agent-uuid-2', name: 'Step B' },
			],
			transitions: [
				{
					id: 'trans-uuid-1',
					from: 'step-uuid-1',
					to: 'step-uuid-2',
					isCyclic: true,
				},
			],
			startStepId: 'step-uuid-1',
			rules: [],
		});
		const exported = exportWorkflow(workflow, []);

		expect(exported.transitions).toHaveLength(1);
		expect(exported.transitions[0].isCyclic).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// exportBundle
// ---------------------------------------------------------------------------

describe('exportBundle', () => {
	test('creates bundle with correct structure', () => {
		const agents = [makeAgent()];
		const workflows = [makeWorkflow()];
		const bundle = exportBundle(agents, workflows, 'My Bundle', {
			description: 'A test bundle',
			exportedFrom: '/workspace/foo',
		});

		expect(bundle.version).toBe(1);
		expect(bundle.type).toBe('bundle');
		expect(bundle.name).toBe('My Bundle');
		expect(bundle.description).toBe('A test bundle');
		expect(bundle.exportedFrom).toBe('/workspace/foo');
		expect(bundle.agents).toHaveLength(1);
		expect(bundle.workflows).toHaveLength(1);
		expect(typeof bundle.exportedAt).toBe('number');
		expect(bundle.exportedAt).toBeGreaterThan(0);
	});

	test('works with empty agents and workflows', () => {
		const bundle = exportBundle([], [], 'Empty Bundle');
		expect(bundle.agents).toHaveLength(0);
		expect(bundle.workflows).toHaveLength(0);
	});

	test('omits optional fields when not provided', () => {
		const bundle = exportBundle([], [], 'Minimal') as Record<string, unknown>;
		expect('description' in bundle).toBe(false);
		expect('exportedFrom' in bundle).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateExportedAgent
// ---------------------------------------------------------------------------

describe('validateExportedAgent', () => {
	test('accepts a valid v1 agent', () => {
		const agent = makeAgent();
		const exported = exportAgent(agent);
		const result = validateExportedAgent(exported);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe('My Coder');
			expect(result.value.version).toBe(1);
		}
	});

	test('accepts minimal valid agent', () => {
		const data = { version: 1, type: 'agent', name: 'Bot', role: 'general' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(true);
	});

	test('accepts reviewer role', () => {
		const data = { version: 1, type: 'agent', name: 'R', role: 'reviewer' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(true);
	});

	test('accepts any free-form role string', () => {
		// role is a free-form label — no enum validation
		const data = { version: 1, type: 'agent', name: 'Bot', role: 'leader' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(true);
	});

	test('accepts agent with string[] tools', () => {
		const data = { version: 1, type: 'agent', name: 'Bot', role: 'coder', tools: ['bash'] };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.tools).toEqual(['bash']);
		}
	});

	test('rejects agent with object tools (old format)', () => {
		const data = { version: 1, type: 'agent', name: 'Bot', role: 'coder', tools: { bash: true } };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
	});

	test('rejects version > 1 with "requires newer version" message', () => {
		const data = { version: 2, type: 'agent', name: 'Bot', role: 'general' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('requires newer version');
			expect(result.error).toContain('version 2');
		}
	});

	test('rejects version 0 as invalid', () => {
		const data = { version: 0, type: 'agent', name: 'Bot', role: 'general' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('invalid');
		}
	});

	test('rejects missing version', () => {
		const data = { type: 'agent', name: 'Bot', role: 'general' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('invalid');
		}
	});

	test('rejects non-integer version', () => {
		const data = { version: 1.5, type: 'agent', name: 'Bot', role: 'general' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
	});

	test('rejects missing name', () => {
		const data = { version: 1, type: 'agent', role: 'coder' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
	});

	test('rejects non-object input', () => {
		expect(validateExportedAgent(null).ok).toBe(false);
		expect(validateExportedAgent('string').ok).toBe(false);
		expect(validateExportedAgent(42).ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateExportedWorkflow
// ---------------------------------------------------------------------------

describe('validateExportedWorkflow', () => {
	test('accepts a valid v1 workflow', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const result = validateExportedWorkflow(exported);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe('CI Workflow');
			expect(result.value.version).toBe(1);
			expect(result.value.transitions).toHaveLength(2);
			expect(result.value.startNode).toBe('Code step');
		}
	});

	test('accepts minimal valid workflow', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Simple',
			steps: [],
			transitions: [],
			startNode: 'first',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
	});

	test('accepts workflow step with flat agentRef', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [{ agentRef: 'My Coder', name: 'Step' }],
			transitions: [],
			startNode: 'Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.nodes[0].agentRef).toBe('My Coder');
		}
	});

	test('rejects step with empty agentRef', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRef: '', name: 'Step' }],
			transitions: [],
			startNode: 'Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects step missing agentRef', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ name: 'Step' }],
			transitions: [],
			startNode: 'Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('accepts valid transition', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{ fromNode: 'Step A', toNode: 'Step B', condition: { type: 'human' }, order: 0 },
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].fromNode).toBe('Step A');
			expect(result.value.transitions[0].condition).toEqual({ type: 'human' });
		}
	});

	test('accepts condition type with expression', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{
					fromNode: 'Step A',
					toNode: 'Step B',
					condition: { type: 'condition', expression: 'bun test --exit-zero' },
				},
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].condition).toEqual({
				type: 'condition',
				expression: 'bun test --exit-zero',
			});
		}
	});

	test('rejects condition type without expression', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [{ fromNode: 'Step A', toNode: 'Step B', condition: { type: 'condition' } }],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('expression');
		}
	});

	test('rejects condition type with blank expression', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{
					fromNode: 'Step A',
					toNode: 'Step B',
					condition: { type: 'condition', expression: '   ' },
				},
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects transition with empty fromNode', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRef: 'Agent B', name: 'Step B' }],
			transitions: [{ fromNode: '', toNode: 'Step B' }],
			startNode: 'Step B',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects transition whose fromNode does not match any step name', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRef: 'Agent A', name: 'Step A' }],
			transitions: [{ fromNode: 'ghost', toNode: 'Step A' }],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('fromNode');
			expect(result.error).toContain('ghost');
		}
	});

	test('rejects transition whose toNode does not match any step name', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRef: 'Agent A', name: 'Step A' }],
			transitions: [{ fromNode: 'Step A', toNode: 'phantom' }],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('toNode');
			expect(result.error).toContain('phantom');
		}
	});

	test('rejects workflow with duplicate step names', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step A' }, // duplicate
			],
			transitions: [],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('duplicate step name');
			expect(result.error).toContain('Step A');
		}
	});

	test('rejects startStep that does not match any step name', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRef: 'Agent A', name: 'Step A' }],
			transitions: [],
			startNode: 'nonexistent',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('startNode');
			expect(result.error).toContain('nonexistent');
		}
	});

	test('rejects version > 1 with "requires newer version"', () => {
		const data = {
			version: 3,
			type: 'workflow',
			name: 'Simple',
			steps: [],
			transitions: [],
			startNode: 'x',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('requires newer version');
		}
	});

	test('rejects missing version', () => {
		const data = {
			type: 'workflow',
			name: 'Simple',
			steps: [],
			transitions: [],
			startNode: 'x',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects negative version', () => {
		const data = {
			version: -1,
			type: 'workflow',
			name: 'Simple',
			steps: [],
			transitions: [],
			startNode: 'x',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('accepts transition with isCyclic: true', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [{ fromNode: 'Step A', toNode: 'Step B', isCyclic: true }],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].isCyclic).toBe(true);
		}
	});

	test('accepts transition with task_result condition type', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{
					fromNode: 'Step A',
					toNode: 'Step B',
					condition: { type: 'task_result', expression: 'passed' },
				},
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].condition).toEqual({
				type: 'task_result',
				expression: 'passed',
			});
		}
	});

	test('strips unknown fields but preserves isCyclic', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{
					fromNode: 'Step A',
					toNode: 'Step B',
					isCyclic: true,
					unknownField: 'should be stripped',
				},
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].isCyclic).toBe(true);
			expect('unknownField' in result.value.transitions[0]).toBe(false);
		}
	});

	test('rejects task_result condition without expression', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{ agentRef: 'Agent A', name: 'Step A' },
				{ agentRef: 'Agent B', name: 'Step B' },
			],
			transitions: [
				{
					fromNode: 'Step A',
					toNode: 'Step B',
					condition: { type: 'task_result' },
				},
			],
			startNode: 'Step A',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('expression');
		}
	});
});

// ---------------------------------------------------------------------------
// validateExportBundle
// ---------------------------------------------------------------------------

describe('validateExportBundle', () => {
	test('accepts a valid v1 bundle', () => {
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const workflows = [makeWorkflow()];
		const bundle = exportBundle(agents, workflows, 'Bundle');
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe('Bundle');
			expect(result.value.version).toBe(1);
			expect(result.value.agents).toHaveLength(3);
			expect(result.value.workflows).toHaveLength(1);
		}
	});

	test('rejects version > 1', () => {
		const bundle = { ...exportBundle([], [], 'B'), version: 5 };
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('requires newer version');
		}
	});

	test('rejects missing exportedAt', () => {
		const b = exportBundle([], [], 'B') as Record<string, unknown>;
		delete b.exportedAt;
		const result = validateExportBundle(b);
		expect(result.ok).toBe(false);
	});

	test('rejects non-object', () => {
		expect(validateExportBundle(null).ok).toBe(false);
		expect(validateExportBundle([]).ok).toBe(false);
	});

	test('rejects bundle whose nested agent has version > 1', () => {
		const bundle = exportBundle([makeAgent()], [], 'B') as Record<string, unknown>;
		// Override the nested agent's version to simulate a v2 agent embedded in a v1 bundle
		const agents = bundle.agents as Array<Record<string, unknown>>;
		agents[0] = { ...agents[0], version: 2 };
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('agents[0]');
			expect(result.error).toContain('requires newer version');
		}
	});

	test('rejects bundle whose nested workflow has version > 1', () => {
		const bundle = exportBundle([], [makeWorkflow()], 'B') as Record<string, unknown>;
		const workflows = bundle.workflows as Array<Record<string, unknown>>;
		workflows[0] = { ...workflows[0], version: 3 };
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('workflows[0]');
			expect(result.error).toContain('requires newer version');
		}
	});

	test('rejects bundle whose nested agent has invalid (missing) version', () => {
		const bundle = exportBundle([makeAgent()], [], 'B') as Record<string, unknown>;
		const agents = bundle.agents as Array<Record<string, unknown>>;
		const { version: _v, ...agentWithoutVersion } = agents[0];
		agents[0] = agentWithoutVersion;
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('agents[0]');
			expect(result.error).toContain('invalid');
		}
	});
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe('round-trip: export → JSON → validate', () => {
	test('agent round-trip', () => {
		const agent = makeAgent();
		const exported = exportAgent(agent);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedAgent(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe(agent.name);
			expect(result.value.role).toBe(agent.role);
			expect(result.value.model).toBe(agent.model);
			expect(result.value.tools).toEqual(['bash', 'read_file']);
		}
	});

	test('reviewer agent round-trip', () => {
		const agent = makeReviewerAgent();
		const exported = exportAgent(agent);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedAgent(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.role).toBe('reviewer');
		}
	});

	test('workflow round-trip', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe(workflow.name);
			expect(result.value.nodes).toHaveLength(3);
			// agentRef is agent name, not UUID
			expect(result.value.nodes[0].agentRef).toBe('My Coder');
			expect(result.value.nodes[1].agentRef).toBe('Reviewer');
			expect(result.value.nodes[2].agentRef).toBe('Simple Agent');
			// transitions preserved with step names
			expect(result.value.transitions).toHaveLength(2);
			expect(result.value.transitions[0].fromNode).toBe('Code step');
			expect(result.value.transitions[0].toNode).toBe('Review step');
			// startStep preserved as step name
			expect(result.value.startNode).toBe('Code step');
		}
	});

	test('condition type with expression round-trip', () => {
		const workflow = makeWorkflow({
			steps: [
				{ id: 'step-uuid-1', agentId: 'agent-uuid-1', name: 'Build' },
				{ id: 'step-uuid-2', agentId: 'agent-uuid-2', name: 'Deploy' },
			],
			transitions: [
				{
					id: 'trans-uuid-1',
					from: 'step-uuid-1',
					to: 'step-uuid-2',
					condition: { type: 'condition', expression: 'bun test --exit-zero' },
				},
			],
			startStepId: 'step-uuid-1',
			rules: [],
		});
		const exported = exportWorkflow(workflow, []);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.transitions[0].condition).toEqual({
				type: 'condition',
				expression: 'bun test --exit-zero',
			});
		}
	});

	test('bundle round-trip', () => {
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const workflows = [makeWorkflow()];
		const bundle = exportBundle(agents, workflows, 'My Bundle', {
			description: 'Test',
			exportedFrom: '/workspace',
		});
		const json = JSON.stringify(bundle);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportBundle(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.agents).toHaveLength(3);
			expect(result.value.workflows).toHaveLength(1);
			expect(result.value.exportedFrom).toBe('/workspace');
		}
	});
});

// ---------------------------------------------------------------------------
// rule appliesTo round-trip (verify step names in JSON)
// ---------------------------------------------------------------------------

describe('rule appliesTo round-trip', () => {
	test('step names appear in serialized JSON, not UUIDs', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);
		const json = JSON.stringify(exported);

		// step UUIDs must NOT appear
		expect(json).not.toContain('step-uuid-1');
		expect(json).not.toContain('step-uuid-2');
		expect(json).not.toContain('step-uuid-3');

		// transition UUIDs must NOT appear
		expect(json).not.toContain('trans-uuid-1');
		expect(json).not.toContain('trans-uuid-2');

		// appliesTo must contain step names (strings)
		const parsed = JSON.parse(json) as { rules: Array<{ appliesTo?: string[] }> };
		expect(parsed.rules[0].appliesTo).toEqual(['Code step', 'Review step']);
	});

	test('workflow round-trip preserves rule appliesTo step names', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.rules[0].appliesTo).toEqual(['Code step', 'Review step']);
		}
	});

	test('agent UUIDs do not appear in JSON after export', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);

		// UUIDs must not appear in exported JSON
		expect(json).not.toContain('agent-uuid-1');
		expect(json).not.toContain('agent-uuid-2');
		expect(json).not.toContain('agent-uuid-3');
		// Names must appear instead
		expect(json).toContain('My Coder');
		expect(json).toContain('Reviewer');
		expect(json).toContain('Simple Agent');
	});
});

// ---------------------------------------------------------------------------
// Multi-agent step export tests
// ---------------------------------------------------------------------------

describe('exportWorkflow — multi-agent steps', () => {
	function makeMultiAgentWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
		return {
			id: 'workflow-uuid-ma',
			spaceId: 'space-uuid-1',
			name: 'Multi-Agent Workflow',
			description: 'Tests multi-agent steps',
			steps: [
				{
					id: 'step-uuid-1',
					name: 'Parallel code+review',
					agents: [
						{ agentId: 'agent-uuid-1', instructions: 'Write the feature' },
						{ agentId: 'agent-uuid-3' },
					],
					channels: [
						{
							from: 'coder',
							to: 'reviewer',
							direction: 'bidirectional',
						},
					],
				},
				{
					id: 'step-uuid-2',
					name: 'Single plan step',
					agentId: 'agent-uuid-2',
				},
			],
			transitions: [{ id: 'trans-1', from: 'step-uuid-1', to: 'step-uuid-2' }],
			startStepId: 'step-uuid-1',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
			...overrides,
		};
	}

	test('exports multi-agent step as agents array (not agentRef)', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		const step = exported.nodes[0];
		// Multi-agent step uses agents array, not agentRef
		expect(step.agents).toHaveLength(2);
		expect(step.agentRef).toBeUndefined();
	});

	test('resolves agentId UUIDs to agent names in agents array', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		const step = exported.nodes[0];
		expect(step.agents![0].agentRef).toBe('My Coder');
		expect(step.agents![1].agentRef).toBe('Reviewer');
	});

	test('preserves per-agent instructions in agents array', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		expect(exported.nodes[0].agents![0].instructions).toBe('Write the feature');
		expect(exported.nodes[0].agents![1].instructions).toBeUndefined();
	});

	test('falls back to UUID for unresolved agent in multi-agent step', () => {
		const workflow = makeMultiAgentWorkflow();
		// Pass no agents — all refs fall back to UUID
		const exported = exportWorkflow(workflow, []);

		expect(exported.nodes[0].agents![0].agentRef).toBe('agent-uuid-1');
		expect(exported.nodes[0].agents![1].agentRef).toBe('agent-uuid-3');
	});

	test('exports channels as-is (role strings, not UUIDs)', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		const step = exported.nodes[0];
		expect(step.channels).toHaveLength(1);
		expect(step.channels![0].from).toBe('coder');
		expect(step.channels![0].to).toBe('reviewer');
		expect(step.channels![0].direction).toBe('bidirectional');
	});

	test('omits channels when step has no channels', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		// Single-agent step (step 1) has no channels
		expect(exported.nodes[1].channels).toBeUndefined();
	});

	test('single-agent step with channels exports channels', () => {
		const workflow = makeMultiAgentWorkflow({
			steps: [
				{
					id: 'step-uuid-1',
					name: 'Solo with channel',
					agentId: 'agent-uuid-1',
					channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
				},
			],
			startStepId: 'step-uuid-1',
			transitions: [],
		});
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		const step = exported.nodes[0];
		// Should still use scalar agentRef (single-agent)
		expect(step.agentRef).toBe('My Coder');
		expect(step.agents).toBeUndefined();
		// Channels should be exported as-is
		expect(step.channels).toHaveLength(1);
		expect(step.channels![0].from).toBe('coder');
		expect(step.channels![0].to).toBe('*');
		expect(step.channels![0].direction).toBe('one-way');
	});

	test('export produces no agentRef when step has neither agentId nor agents', () => {
		const workflow = makeMultiAgentWorkflow({
			steps: [{ id: 'step-uuid-1', name: 'Broken step' } as any],
			startStepId: 'step-uuid-1',
			transitions: [],
		});
		const exported = exportWorkflow(workflow, []);

		const step = exported.nodes[0];
		// Neither agentRef nor agents should be set
		expect(step.agentRef).toBeUndefined();
		expect(step.agents).toBeUndefined();
	});

	test('single-agent step still exports as agentRef shorthand', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);

		// Step 1 uses agentId shorthand (not agents[])
		const step = exported.nodes[1];
		expect(step.agentRef).toBe('Simple Agent');
		expect(step.agents).toBeUndefined();
	});

	test('agent UUIDs do not appear in multi-agent exported JSON', () => {
		const workflow = makeMultiAgentWorkflow();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);

		expect(json).not.toContain('agent-uuid-1');
		expect(json).not.toContain('agent-uuid-3');
		expect(json).toContain('My Coder');
		expect(json).toContain('Reviewer');
	});
});

// ---------------------------------------------------------------------------
// validateExportedWorkflow — multi-agent + channels
// ---------------------------------------------------------------------------

describe('validateExportedWorkflow — multi-agent and channels', () => {
	test('accepts step with agents array', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{
					agents: [{ agentRef: 'My Coder', instructions: 'Code it' }, { agentRef: 'Reviewer' }],
					name: 'Parallel Step',
				},
			],
			transitions: [],
			startNode: 'Parallel Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.nodes[0].agents).toHaveLength(2);
			expect(result.value.nodes[0].agents![0].agentRef).toBe('My Coder');
			expect(result.value.nodes[0].agents![0].instructions).toBe('Code it');
			expect(result.value.nodes[0].agentRef).toBeUndefined();
		}
	});

	test('accepts step with channels', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{
					agents: [{ agentRef: 'Coder' }, { agentRef: 'Reviewer' }],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'bidirectional' }],
					name: 'Step',
				},
			],
			transitions: [],
			startNode: 'Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.nodes[0].channels).toHaveLength(1);
			expect(result.value.nodes[0].channels![0].from).toBe('coder');
			expect(result.value.nodes[0].channels![0].direction).toBe('bidirectional');
		}
	});

	test('accepts channel with array `to` field (fan-out topology)', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'W',
			steps: [
				{
					agents: [{ agentRef: 'Hub' }, { agentRef: 'Spoke1' }, { agentRef: 'Spoke2' }],
					channels: [{ from: 'hub', to: ['spoke1', 'spoke2'], direction: 'one-way' }],
					name: 'Fan-out',
				},
			],
			transitions: [],
			startNode: 'Fan-out',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.nodes[0].channels![0].to).toEqual(['spoke1', 'spoke2']);
		}
	});

	test('rejects step with empty agents array and no agentRef', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agents: [], name: 'Empty agents step' }],
			transitions: [],
			startNode: 'Empty agents step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('step must have either agentRef or agents');
		}
	});

	test('rejects agent entry with empty agentRef in agents array', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [
				{
					agents: [{ agentRef: '' }],
					name: 'Step',
				},
			],
			transitions: [],
			startNode: 'Step',
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Multi-agent round-trip: export → JSON → validate
// ---------------------------------------------------------------------------

describe('round-trip: multi-agent + channels', () => {
	function makeMultiAgentWorkflowForRoundTrip(): SpaceWorkflow {
		return {
			id: 'wf-1',
			spaceId: 'space-1',
			name: 'Collab Workflow',
			description: 'Coder and reviewer in parallel',
			steps: [
				{
					id: 'step-1',
					name: 'Code and Review',
					agents: [
						{ agentId: 'agent-uuid-1', instructions: 'Implement the feature' },
						{ agentId: 'agent-uuid-3', instructions: 'Review the code' },
					],
					channels: [
						{ from: 'coder', to: 'reviewer', direction: 'bidirectional', label: 'feedback' },
					],
					instructions: 'Collaborate on the feature',
				},
				{
					id: 'step-2',
					name: 'Final Plan',
					agentId: 'agent-uuid-2',
				},
			],
			transitions: [{ id: 't-1', from: 'step-1', to: 'step-2' }],
			startStepId: 'step-1',
			rules: [],
			tags: ['collab'],
			createdAt: 1000,
			updatedAt: 2000,
		};
	}

	test('multi-agent step round-trip preserves agents array and channels', () => {
		const workflow = makeMultiAgentWorkflowForRoundTrip();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const step = result.value.nodes[0];
			// Multi-agent step preserved
			expect(step.agents).toHaveLength(2);
			expect(step.agents![0].agentRef).toBe('My Coder');
			expect(step.agents![0].instructions).toBe('Implement the feature');
			expect(step.agents![1].agentRef).toBe('Reviewer');
			expect(step.agents![1].instructions).toBe('Review the code');
			// agentRef shorthand absent for multi-agent step
			expect(step.agentRef).toBeUndefined();
			// Channels preserved
			expect(step.channels).toHaveLength(1);
			expect(step.channels![0].from).toBe('coder');
			expect(step.channels![0].to).toBe('reviewer');
			expect(step.channels![0].direction).toBe('bidirectional');
			expect(step.channels![0].label).toBe('feedback');
			// Shared instructions preserved
			expect(step.instructions).toBe('Collaborate on the feature');
		}
	});

	test('single-agent step in mixed workflow round-trips as agentRef', () => {
		const workflow = makeMultiAgentWorkflowForRoundTrip();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const step = result.value.nodes[1];
			expect(step.agentRef).toBe('Simple Agent');
			expect(step.agents).toBeUndefined();
			expect(step.channels).toBeUndefined();
		}
	});

	test('no UUIDs in multi-agent exported JSON', () => {
		const workflow = makeMultiAgentWorkflowForRoundTrip();
		const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);

		expect(json).not.toContain('agent-uuid-1');
		expect(json).not.toContain('agent-uuid-2');
		expect(json).not.toContain('agent-uuid-3');
		expect(json).not.toContain('step-1');
		expect(json).not.toContain('step-2');
		expect(json).toContain('My Coder');
		expect(json).toContain('Reviewer');
		expect(json).toContain('Simple Agent');
	});
});
