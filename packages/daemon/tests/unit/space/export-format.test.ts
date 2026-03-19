/**
 * Export Format Unit Tests
 *
 * Covers:
 * - exportAgent: strips space-specific fields, maps toolConfig → tools
 * - exportWorkflow: strips step IDs, remaps custom agentRef UUID → name,
 *   remaps rule appliesTo step UUIDs → order indices
 * - exportBundle: wraps agents + workflows, adds exportedAt
 * - validateExportedAgent: accepts v1, rejects malformed, version checks
 * - validateExportedWorkflow: accepts v1, rejects malformed, version checks
 * - validateExportBundle: accepts v1, nested agent/workflow validation
 * - Round-trip: export → JSON serialize → deserialize → validate
 * - rule appliesTo round-trip: verify order indices in JSON, verify on re-import
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
		toolConfig: { bash: true, read_file: true },
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

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'workflow-uuid-1',
		spaceId: 'space-uuid-1',
		name: 'CI Workflow',
		description: 'Runs CI pipeline',
		steps: [
			{
				id: 'step-uuid-1',
				agentRefType: 'builtin',
				agentRef: 'coder',
				name: 'Code step',
				order: 0,
			},
			{
				id: 'step-uuid-2',
				agentRefType: 'custom',
				agentRef: 'agent-uuid-1',
				name: 'Review step',
				order: 1,
				instructions: 'Review carefully',
			},
			{
				id: 'step-uuid-3',
				agentRefType: 'builtin',
				agentRef: 'planner',
				name: 'Plan step',
				order: 2,
			},
		],
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
		expect(exported.tools).toEqual({ bash: true, read_file: true });
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

	test('maps toolConfig → tools', () => {
		const agent = makeAgent({ toolConfig: { edit_file: true } });
		const exported = exportAgent(agent);
		expect(exported.tools).toEqual({ edit_file: true });
	});
});

// ---------------------------------------------------------------------------
// exportWorkflow
// ---------------------------------------------------------------------------

describe('exportWorkflow', () => {
	test('strips workflow-level space fields', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents) as Record<string, unknown>;

		expect('id' in exported).toBe(false);
		expect('spaceId' in exported).toBe(false);
		expect('createdAt' in exported).toBe(false);
		expect('updatedAt' in exported).toBe(false);
	});

	test('strips step IDs', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		for (const step of exported.steps) {
			expect('id' in step).toBe(false);
		}
	});

	test('retains step order, name, and other fields', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		expect(exported.steps[0].order).toBe(0);
		expect(exported.steps[0].name).toBe('Code step');
		expect(exported.steps[1].order).toBe(1);
		expect(exported.steps[1].name).toBe('Review step');
		expect(exported.steps[1].instructions).toBe('Review carefully');
		expect(exported.steps[2].order).toBe(2);
	});

	test('remaps custom agentRef UUID → agent name', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()]; // id: 'agent-uuid-1', name: 'My Coder'
		const exported = exportWorkflow(workflow, agents);

		const reviewStep = exported.steps[1];
		expect(reviewStep.agentRefType).toBe('custom');
		expect(reviewStep.agentRef).toBe('My Coder');
	});

	test('preserves builtin agentRef as-is', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);

		expect(exported.steps[0].agentRefType).toBe('builtin');
		expect(exported.steps[0].agentRef).toBe('coder');
		expect(exported.steps[2].agentRefType).toBe('builtin');
		expect(exported.steps[2].agentRef).toBe('planner');
	});

	test('falls back to UUID when agent not found', () => {
		const workflow = makeWorkflow();
		// Pass no agents — custom ref should fall back to UUID
		const exported = exportWorkflow(workflow, []);
		const reviewStep = exported.steps[1];
		expect(reviewStep.agentRef).toBe('agent-uuid-1');
	});

	test('remaps rule appliesTo step UUIDs → order indices', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		// rule 0: appliesTo step-uuid-1 (order 0) and step-uuid-2 (order 1)
		expect(exported.rules[0].appliesTo).toEqual([0, 1]);
	});

	test('omits appliesTo for rule with empty appliesTo array', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);

		// rule 1: appliesTo is []
		expect(exported.rules[1].appliesTo).toBeUndefined();
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

	test('rejects invalid role', () => {
		const data = { version: 1, type: 'agent', name: 'Bot', role: 'leader' };
		const result = validateExportedAgent(data);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('invalid');
		}
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
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);
		const result = validateExportedWorkflow(exported);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe('CI Workflow');
			expect(result.value.version).toBe(1);
		}
	});

	test('accepts minimal valid workflow', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Simple',
			steps: [],
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(true);
	});

	test('rejects version > 1 with "requires newer version"', () => {
		const data = {
			version: 3,
			type: 'workflow',
			name: 'Simple',
			steps: [],
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
		const data = { type: 'workflow', name: 'Simple', steps: [], rules: [], tags: [] };
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects negative version', () => {
		const data = { version: -1, type: 'workflow', name: 'Simple', steps: [], rules: [], tags: [] };
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects step with invalid agentRefType', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRefType: 'unknown', agentRef: 'foo', name: 'Step', order: 0 }],
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects builtin step with leader agentRef', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [{ agentRefType: 'builtin', agentRef: 'leader', name: 'Step', order: 0 }],
			rules: [],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});

	test('rejects rule with negative appliesTo index', () => {
		const data = {
			version: 1,
			type: 'workflow',
			name: 'Bad',
			steps: [],
			rules: [{ name: 'Rule', content: 'Content', appliesTo: [-1] }],
			tags: [],
		};
		const result = validateExportedWorkflow(data);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateExportBundle
// ---------------------------------------------------------------------------

describe('validateExportBundle', () => {
	test('accepts a valid v1 bundle', () => {
		const agents = [makeAgent()];
		const workflows = [makeWorkflow()];
		const bundle = exportBundle(agents, workflows, 'Bundle');
		const result = validateExportBundle(bundle);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe('Bundle');
			expect(result.value.version).toBe(1);
			expect(result.value.agents).toHaveLength(1);
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
		}
	});

	test('workflow round-trip', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe(workflow.name);
			expect(result.value.steps).toHaveLength(3);
		}
	});

	test('bundle round-trip', () => {
		const agents = [makeAgent(), makeMinimalAgent()];
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
			expect(result.value.agents).toHaveLength(2);
			expect(result.value.workflows).toHaveLength(1);
			expect(result.value.exportedFrom).toBe('/workspace');
		}
	});
});

// ---------------------------------------------------------------------------
// rule appliesTo round-trip (verify order indices in JSON)
// ---------------------------------------------------------------------------

describe('rule appliesTo round-trip', () => {
	test('order indices appear in serialized JSON, not UUIDs', () => {
		const workflow = makeWorkflow();
		const exported = exportWorkflow(workflow, []);
		const json = JSON.stringify(exported);

		// step UUIDs must NOT appear
		expect(json).not.toContain('step-uuid-1');
		expect(json).not.toContain('step-uuid-2');
		expect(json).not.toContain('step-uuid-3');

		// appliesTo must contain numbers (0 and 1)
		const parsed = JSON.parse(json) as { rules: Array<{ appliesTo?: number[] }> };
		expect(parsed.rules[0].appliesTo).toEqual([0, 1]);
	});

	test('workflow round-trip preserves rule appliesTo order indices', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()];
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);
		const parsed = JSON.parse(json) as unknown;
		const result = validateExportedWorkflow(parsed);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.rules[0].appliesTo).toEqual([0, 1]);
		}
	});

	test('custom agentRef UUID does not appear in JSON after export', () => {
		const workflow = makeWorkflow();
		const agents = [makeAgent()]; // agent-uuid-1 → 'My Coder'
		const exported = exportWorkflow(workflow, agents);
		const json = JSON.stringify(exported);

		// UUID must not appear in exported JSON
		expect(json).not.toContain('agent-uuid-1');
		// Name must appear instead
		expect(json).toContain('My Coder');
	});
});
