import { describe, test, expect } from 'bun:test';
import type {
	CompletionAction,
	SpaceAutonomyLevel,
	SpaceWorkflow,
	WorkflowNode,
} from '../src/types/space.ts';
import {
	EMPTY_ACTIONS_AUTONOMY_THRESHOLD,
	countAutonomousWorkflows,
	isAutonomousWithoutActions,
	isWorkflowAutonomousAtLevel,
} from '../src/space/workflow-autonomy.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeScriptAction(
	id: string,
	requiredLevel: SpaceAutonomyLevel,
	overrides: Partial<CompletionAction> = {}
): CompletionAction {
	return {
		type: 'script',
		id,
		name: `action-${id}`,
		script: 'echo ok',
		requiredLevel,
		...overrides,
	} as CompletionAction;
}

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
	return {
		id: 'node-1',
		name: 'Node 1',
		agents: [{ agentId: 'agent-1', name: 'agent-1' }],
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Workflow 1',
		nodes: [makeNode()],
		startNodeId: 'node-1',
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

// ── isAutonomousWithoutActions + threshold constant ───────────────────────

describe('isAutonomousWithoutActions', () => {
	test('threshold constant is 2 (mirrors space-runtime.ts)', () => {
		expect(EMPTY_ACTIONS_AUTONOMY_THRESHOLD).toBe(2);
	});

	test('level >= 2 is autonomous, level < 2 is not', () => {
		expect(isAutonomousWithoutActions(1)).toBe(false);
		expect(isAutonomousWithoutActions(2)).toBe(true);
		expect(isAutonomousWithoutActions(3)).toBe(true);
		expect(isAutonomousWithoutActions(5)).toBe(true);
	});
});

// ── isWorkflowAutonomousAtLevel ───────────────────────────────────────────

describe('isWorkflowAutonomousAtLevel', () => {
	test('all actions requiredLevel 2 → autonomous at level ≥ 2, blocked at 1', () => {
		const wf = makeWorkflow({
			nodes: [
				makeNode({
					completionActions: [makeScriptAction('a1', 2), makeScriptAction('a2', 2)],
				}),
			],
		});

		expect(isWorkflowAutonomousAtLevel(wf, 1)).toBe(false);
		expect(isWorkflowAutonomousAtLevel(wf, 2)).toBe(true);
		expect(isWorkflowAutonomousAtLevel(wf, 3)).toBe(true);
		expect(isWorkflowAutonomousAtLevel(wf, 5)).toBe(true);
	});

	test('mixed action levels — one action at 4 forces level ≥ 4', () => {
		const wf = makeWorkflow({
			nodes: [
				makeNode({
					id: 'n-a',
					name: 'A',
					completionActions: [makeScriptAction('a1', 2), makeScriptAction('a2', 3)],
				}),
				makeNode({
					id: 'n-b',
					name: 'B',
					completionActions: [makeScriptAction('b1', 4)],
				}),
			],
		});

		expect(isWorkflowAutonomousAtLevel(wf, 1)).toBe(false);
		expect(isWorkflowAutonomousAtLevel(wf, 2)).toBe(false);
		expect(isWorkflowAutonomousAtLevel(wf, 3)).toBe(false);
		expect(isWorkflowAutonomousAtLevel(wf, 4)).toBe(true);
		expect(isWorkflowAutonomousAtLevel(wf, 5)).toBe(true);
	});

	test('zero completion actions → follows runtime fallback (≥ 2)', () => {
		const wf = makeWorkflow({
			nodes: [makeNode({ completionActions: [] }), makeNode({ id: 'n-2', name: 'N2' })],
		});

		expect(isWorkflowAutonomousAtLevel(wf, 1)).toBe(false);
		expect(isWorkflowAutonomousAtLevel(wf, 2)).toBe(true);
		expect(isWorkflowAutonomousAtLevel(wf, 5)).toBe(true);
	});
});

// ── countAutonomousWorkflows ──────────────────────────────────────────────

describe('countAutonomousWorkflows', () => {
	test('empty workflow list → {autonomous: 0, total: 0, blocking: []}', () => {
		expect(countAutonomousWorkflows([], 1)).toEqual({
			autonomous: 0,
			total: 0,
			blocking: [],
		});
		expect(countAutonomousWorkflows([], 5)).toEqual({
			autonomous: 0,
			total: 0,
			blocking: [],
		});
	});

	test('counts autonomous vs. blocked workflows across mixed levels', () => {
		const easy = makeWorkflow({
			id: 'wf-easy',
			name: 'Easy',
			nodes: [makeNode({ completionActions: [makeScriptAction('e1', 2)] })],
		});
		const hard = makeWorkflow({
			id: 'wf-hard',
			name: 'Hard',
			nodes: [
				makeNode({
					name: 'Deploy',
					completionActions: [makeScriptAction('h1', 4, { name: 'Merge PR' })],
				}),
			],
		});
		const empty = makeWorkflow({
			id: 'wf-empty',
			name: 'Review Only',
			nodes: [makeNode({ completionActions: [] })],
		});

		const workflows = [easy, hard, empty];

		// At level 1: easy blocked (needs 2), hard blocked (needs 4), empty blocked (needs 2 fallback).
		const atOne = countAutonomousWorkflows(workflows, 1);
		expect(atOne.autonomous).toBe(0);
		expect(atOne.total).toBe(3);
		expect(atOne.blocking.map((b) => b.workflowId).sort()).toEqual([
			'wf-easy',
			'wf-empty',
			'wf-hard',
		]);

		// At level 3: easy autonomous, hard still blocked by Merge PR (level 4), empty autonomous.
		const atThree = countAutonomousWorkflows(workflows, 3);
		expect(atThree.autonomous).toBe(2);
		expect(atThree.total).toBe(3);
		expect(atThree.blocking).toHaveLength(1);
		expect(atThree.blocking[0]).toMatchObject({
			workflowId: 'wf-hard',
			workflowName: 'Hard',
			blockedBy: [
				{
					nodeName: 'Deploy',
					actionId: 'h1',
					requiredLevel: 4,
				},
			],
		});

		// At level 5: everything autonomous.
		const atFive = countAutonomousWorkflows(workflows, 5);
		expect(atFive).toEqual({ autonomous: 3, total: 3, blocking: [] });
	});

	test('lists every blocking action across multiple nodes in one workflow', () => {
		const wf = makeWorkflow({
			id: 'wf-multi',
			name: 'Multi-Node',
			nodes: [
				makeNode({
					id: 'n1',
					name: 'Plan',
					completionActions: [makeScriptAction('p1', 4, { name: 'Dispatch' })],
				}),
				makeNode({
					id: 'n2',
					name: 'Ship',
					completionActions: [
						makeScriptAction('s1', 2, { name: 'Lint' }),
						makeScriptAction('s2', 5, { name: 'Release' }),
					],
				}),
			],
		});

		const atThree = countAutonomousWorkflows([wf], 3);
		expect(atThree.autonomous).toBe(0);
		expect(atThree.blocking).toHaveLength(1);
		expect(atThree.blocking[0].blockedBy.map((b) => b.actionId).sort()).toEqual(['p1', 's2']);
		expect(atThree.blocking[0].blockedBy.find((b) => b.actionId === 'p1')).toMatchObject({
			nodeName: 'Plan',
			requiredLevel: 4,
		});
		expect(atThree.blocking[0].blockedBy.find((b) => b.actionId === 's2')).toMatchObject({
			nodeName: 'Ship',
			requiredLevel: 5,
		});
	});

	test('empty-actions workflow reports a blocking entry with no blockedBy at level 1', () => {
		const wf = makeWorkflow({
			id: 'wf-empty',
			name: 'Review Only',
			nodes: [makeNode({ completionActions: undefined })],
		});

		const atOne = countAutonomousWorkflows([wf], 1);
		expect(atOne.autonomous).toBe(0);
		expect(atOne.blocking).toEqual([
			{ workflowId: 'wf-empty', workflowName: 'Review Only', blockedBy: [] },
		]);
	});
});
