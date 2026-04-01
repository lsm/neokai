import { describe, test, expect } from 'bun:test';
import type { SpaceAgent, SpaceWorkflow, WorkflowNode } from '@neokai/shared';
import { resolveChannels, validateChannels } from '@neokai/shared';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(id: string): SpaceAgent {
	return { id, spaceId: 'space-1', name: id, role: 'coder', createdAt: 0, updatedAt: 0 };
}

function makeNode(
	id: string,
	name: string,
	agents: Array<{ name: string; agentId: string }>
): WorkflowNode {
	return {
		id,
		name,
		agents: agents.map((a) => ({ agentId: a.agentId, name: a.name })),
	};
}

function makeWorkflow(nodes: WorkflowNode[], channels?: SpaceWorkflow['channels']): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		nodes,
		transitions: [],
		startNodeId: nodes[0]?.id ?? '',
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		channels,
	};
}

// ============================================================================
// resolveChannels tests
// ============================================================================

describe('resolveChannels', () => {
	test('within-node DM: two agents in same node, one-way channel between them', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'reviewer', direction: 'one-way' }]);
		const result = resolveChannels(wf);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			fromAgentId: 'agent-coder',
			toAgentId: 'agent-reviewer',
			direction: 'one-way',
			isHubSpoke: false,
			isFanOut: false,
		});
	});

	test('within-node broadcast: agent sends to node name (fan-out, isFanOut: true)', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'hub', agentId: 'agent-hub' },
			{ name: 'worker1', agentId: 'agent-w1' },
			{ name: 'worker2', agentId: 'agent-w2' },
		]);
		const wf = makeWorkflow([node], [{ from: 'hub', to: 'Node1', direction: 'one-way' }]);
		const result = resolveChannels(wf);

		// hub sends to worker1 and worker2 (not itself — self-loops skipped)
		expect(result).toHaveLength(2);
		for (const r of result) {
			expect(r.fromRole).toBe('hub');
			expect(r.isFanOut).toBe(true);
			expect(r.isHubSpoke).toBe(false);
			expect(r.direction).toBe('one-way');
		}
		const toRoles = result.map((r) => r.toRole).sort();
		expect(toRoles).toEqual(['worker1', 'worker2']);
	});

	test('cross-node DM: agent in node A sends to agent in node B', () => {
		const nodeA = makeNode('n1', 'NodeA', [{ name: 'coder', agentId: 'agent-coder' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'reviewer', agentId: 'agent-reviewer' }]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'coder', to: 'reviewer', direction: 'one-way' }]
		);
		const result = resolveChannels(wf);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			fromAgentId: 'agent-coder',
			toAgentId: 'agent-reviewer',
			direction: 'one-way',
			isFanOut: false,
			isHubSpoke: false,
		});
	});

	test('cross-node fan-out: agent in node A sends to node B name (all agents)', () => {
		const nodeA = makeNode('n1', 'NodeA', [{ name: 'planner', agentId: 'agent-planner' }]);
		const nodeB = makeNode('n2', 'NodeB', [
			{ name: 'coder1', agentId: 'agent-coder1' },
			{ name: 'coder2', agentId: 'agent-coder2' },
		]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'planner', to: 'NodeB', direction: 'one-way' }]
		);
		const result = resolveChannels(wf);

		expect(result).toHaveLength(2);
		for (const r of result) {
			expect(r.fromRole).toBe('planner');
			expect(r.isFanOut).toBe(true);
		}
		const toRoles = result.map((r) => r.toRole).sort();
		expect(toRoles).toEqual(['coder1', 'coder2']);
	});

	test('bidirectional point-to-point: expands to two one-way entries', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'alice', agentId: 'agent-alice' },
			{ name: 'bob', agentId: 'agent-bob' },
		]);
		const wf = makeWorkflow([node], [{ from: 'alice', to: 'bob', direction: 'bidirectional' }]);
		const result = resolveChannels(wf);

		expect(result).toHaveLength(2);
		const aliceToBob = result.find((r) => r.fromRole === 'alice' && r.toRole === 'bob');
		const bobToAlice = result.find((r) => r.fromRole === 'bob' && r.toRole === 'alice');
		expect(aliceToBob).toBeDefined();
		expect(bobToAlice).toBeDefined();
		expect(aliceToBob!.isHubSpoke).toBe(false);
		expect(bobToAlice!.isHubSpoke).toBe(false);
	});

	test('bidirectional hub-spoke: one sender, multiple receivers bidirectionally', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'hub', agentId: 'agent-hub' },
			{ name: 'spoke1', agentId: 'agent-spoke1' },
			{ name: 'spoke2', agentId: 'agent-spoke2' },
		]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'hub', to: ['spoke1', 'spoke2'], direction: 'bidirectional' }]
		);
		const result = resolveChannels(wf);

		// hub→spoke1, hub→spoke2, spoke1→hub, spoke2→hub = 4 entries
		expect(result).toHaveLength(4);
		for (const r of result) {
			expect(r.isHubSpoke).toBe(true);
		}
		const hubToSpoke = result.filter((r) => r.fromRole === 'hub');
		const spokeToHub = result.filter((r) => r.toRole === 'hub');
		expect(hubToSpoke).toHaveLength(2);
		expect(spokeToHub).toHaveLength(2);
	});

	test('self-loop skipped: from === to generates no entry', () => {
		const node = makeNode('n1', 'Node1', [{ name: 'coder', agentId: 'agent-coder' }]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'coder', direction: 'one-way' }]);
		const result = resolveChannels(wf);
		expect(result).toHaveLength(0);
	});

	test('unresolvable references silently skipped', () => {
		const node = makeNode('n1', 'Node1', [{ name: 'coder', agentId: 'agent-coder' }]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'unknown-role', to: 'also-unknown', direction: 'one-way' }]
		);
		const result = resolveChannels(wf);
		expect(result).toHaveLength(0);
	});

	test('wildcard from/to: backward compat with * syntax', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
			{ name: 'tester', agentId: 'agent-tester' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: '*', direction: 'one-way' }]);
		const result = resolveChannels(wf);

		// coder→reviewer, coder→tester (self-loop skipped)
		expect(result).toHaveLength(2);
		for (const r of result) {
			expect(r.fromRole).toBe('coder');
		}
	});

	test('empty workflow: returns empty array', () => {
		const wf = makeWorkflow([]);
		const result = resolveChannels(wf);
		expect(result).toHaveLength(0);
	});

	test('maxCycles is propagated from source WorkflowChannel', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'coder', to: 'reviewer', direction: 'one-way', maxCycles: 3 }]
		);
		const result = resolveChannels(wf);

		expect(result).toHaveLength(1);
		expect(result[0].maxCycles).toBe(3);
	});
});

// ============================================================================
// validateChannels tests
// ============================================================================

describe('validateChannels', () => {
	test('valid channels pass: no errors', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'reviewer', direction: 'one-way' }]);
		const errors = validateChannels(wf, agents);
		expect(errors).toHaveLength(0);
	});

	test('invalid from reference: error about unknown role/node', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'unknown-role', to: 'reviewer', direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('unknown-role');
	});

	test('invalid to reference: error about unknown role/node', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'coder', to: 'unknown-target', direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('unknown-target');
	});

	test('duplicate roles across nodes: error reported', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-coder2')];
		const nodeA = makeNode('n1', 'NodeA', [{ name: 'coder', agentId: 'agent-coder' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'coder', agentId: 'agent-coder2' }]);
		// Need at least one channel so validation runs
		const wf = makeWorkflow([nodeA, nodeB], [{ from: 'coder', to: 'coder', direction: 'one-way' }]);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		const dupeError = errors.find((e) => e.includes('globally unique'));
		expect(dupeError).toBeDefined();
	});

	test('wildcard mixed in array to: error reported', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow(
			[node],
			[{ from: 'coder', to: ['reviewer', '*'], direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("mixes wildcard '*'"))).toBe(true);
	});

	test('agent not in space agents: error reported', () => {
		// Space agents list does not include agent-coder
		const agents = [makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'reviewer', direction: 'one-way' }]);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('agent-coder'))).toBe(true);
	});

	test('empty channels: returns empty array', () => {
		const agents = [makeAgent('agent-coder')];
		const node = makeNode('n1', 'Node1', [{ name: 'coder', agentId: 'agent-coder' }]);
		// No channels on workflow or node
		const wf = makeWorkflow([node]);
		const errors = validateChannels(wf, agents);
		expect(errors).toHaveLength(0);
	});

	test('node-level channel references valid role: no errors', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'reviewer', direction: 'one-way' }]);
		const errors = validateChannels(wf, agents);
		expect(errors).toHaveLength(0);
	});

	test('node-level channel with invalid role: error reported', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow([node], [{ from: 'coder', to: 'nonexistent', direction: 'one-way' }]);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('nonexistent'))).toBe(true);
	});

	test('cross-node fan-out via node name: valid when node name exists', () => {
		const agents = [makeAgent('agent-planner'), makeAgent('agent-coder')];
		const nodeA = makeNode('n1', 'NodeA', [{ name: 'planner', agentId: 'agent-planner' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'coder', agentId: 'agent-coder' }]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'planner', to: 'NodeB', direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors).toHaveLength(0);
	});

	test('node-name/role-name collision: ambiguity error reported for from', () => {
		// Node named "coder" and an agent with role "coder" in a different node
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const nodeA = makeNode('coder', 'coder', [{ name: 'reviewer', agentId: 'agent-reviewer' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'coder', agentId: 'agent-coder' }]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'coder', to: 'reviewer', direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('ambiguous'))).toBe(true);
	});

	test('node-name/role-name collision: ambiguity error reported for to', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const nodeA = makeNode('n1', 'reviewer', [{ name: 'coder', agentId: 'agent-coder' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'reviewer', agentId: 'agent-reviewer' }]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'coder', to: 'reviewer', direction: 'one-way' }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('ambiguous'))).toBe(true);
	});

	test('invalid direction value: error reported', () => {
		const agents = [makeAgent('agent-coder'), makeAgent('agent-reviewer')];
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
		]);
		const wf = makeWorkflow(
			[node],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			[{ from: 'coder', to: 'reviewer', direction: 'invalid' as any }]
		);
		const errors = validateChannels(wf, agents);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('direction'))).toBe(true);
	});
});

// ============================================================================
// resolveChannels edge cases
// ============================================================================

describe('resolveChannels edge cases', () => {
	test('wildcard from (*): expands to all agents sending to target', () => {
		const node = makeNode('n1', 'Node1', [
			{ name: 'coder', agentId: 'agent-coder' },
			{ name: 'reviewer', agentId: 'agent-reviewer' },
			{ name: 'tester', agentId: 'agent-tester' },
		]);
		const wf = makeWorkflow([node], [{ from: '*', to: 'reviewer', direction: 'one-way' }]);
		const result = resolveChannels(wf);

		// coder→reviewer and tester→reviewer (self-loop reviewer→reviewer skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		const fromRoles = result.map((r) => r.fromRole).sort();
		expect(fromRoles).toEqual(['coder', 'tester']);
	});

	test('from as node name: each agent in node gets a sender entry', () => {
		const nodeA = makeNode('n1', 'Coders', [
			{ name: 'coder1', agentId: 'agent-coder1' },
			{ name: 'coder2', agentId: 'agent-coder2' },
		]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'reviewer', agentId: 'agent-reviewer' }]);
		// "Coders" node as from — all agents in Coders send to reviewer
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'Coders', to: 'reviewer', direction: 'one-way' }]
		);
		const result = resolveChannels(wf);

		// coder1→reviewer + coder2→reviewer
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		// isFanOut is false for individual entries even though from was a node name
		expect(result.every((r) => !r.isFanOut)).toBe(true);
	});

	test('bidirectional with fan-out to node name: expands with isFanOut on forward entries', () => {
		const nodeA = makeNode('n1', 'NodeA', [{ name: 'planner', agentId: 'agent-planner' }]);
		const nodeB = makeNode('n2', 'NodeB', [
			{ name: 'coder1', agentId: 'agent-coder1' },
			{ name: 'coder2', agentId: 'agent-coder2' },
		]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'planner', to: 'NodeB', direction: 'bidirectional' }]
		);
		const result = resolveChannels(wf);

		// forward: planner→coder1, planner→coder2 (isFanOut: true)
		// reverse: coder1→planner, coder2→planner (isFanOut: true, same channel)
		expect(result).toHaveLength(4);
		const forward = result.filter((r) => r.fromRole === 'planner');
		const reverse = result.filter((r) => r.toRole === 'planner');
		expect(forward).toHaveLength(2);
		expect(reverse).toHaveLength(2);
		// All are marked isFanOut since to was a node name
		expect(forward.every((r) => r.isFanOut === true)).toBe(true);
		// isHubSpoke: true because single from + multiple to + bidirectional
		expect(result.every((r) => r.isHubSpoke === true)).toBe(true);
	});

	test('node-name/role-name collision: resolver prefers role over node name for to', () => {
		// "coder" is both an agent role in nodeB and the name of nodeA
		const nodeA = makeNode('coder', 'coder', [{ name: 'planner', agentId: 'agent-planner' }]);
		const nodeB = makeNode('n2', 'NodeB', [{ name: 'coder', agentId: 'agent-coder' }]);
		const wf = makeWorkflow(
			[nodeA, nodeB],
			[{ from: 'planner', to: 'coder', direction: 'one-way' }]
		);
		const result = resolveChannels(wf);

		// Resolver prefers role match → single DM to coder agent, NOT fan-out to node "coder"
		expect(result).toHaveLength(1);
		expect(result[0].toRole).toBe('coder');
		expect(result[0].toAgentId).toBe('agent-coder');
		expect(result[0].isFanOut).toBeFalsy();
	});
});
