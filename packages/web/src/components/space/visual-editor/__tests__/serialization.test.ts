/**
 * Unit tests for visual editor serialization helpers.
 *
 * Coverage:
 * - workflowToVisualState: position restoration from layout, auto-layout fallback,
 *   edge mapping, startStepId pass-through
 * - visualStateToCreateParams / visualStateToUpdateParams: round-trip, transition
 *   ordering, layout output, rules remapping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	workflowToVisualState,
	visualStateToCreateParams,
	visualStateToUpdateParams,
} from '../serialization.ts';
import type { VisualEditorState } from '../serialization.ts';
import type { SpaceWorkflow, WorkflowStep, WorkflowTransition, WorkflowRule } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Stable UUID counter so tests are deterministic
// ---------------------------------------------------------------------------

let uuidCounter = 0;
beforeEach(() => {
	uuidCounter = 0;
	vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
		uuidCounter++;
		return `test-uuid-${uuidCounter}` as ReturnType<typeof crypto.randomUUID>;
	});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(id: string, name?: string, agentId?: string): WorkflowStep {
	return { id, name: name ?? id, agentId: agentId ?? 'agent-1' };
}

function makeTransition(
	from: string,
	to: string,
	id?: string,
	order?: number,
	condition?: WorkflowTransition['condition']
): WorkflowTransition {
	return { id: id ?? `${from}->${to}`, from, to, order, condition };
}

function makeRule(id: string, name: string, content: string, appliesTo?: string[]): WorkflowRule {
	return { id, name, content, appliesTo };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		steps: [],
		transitions: [],
		startStepId: '',
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// workflowToVisualState
// ---------------------------------------------------------------------------

describe('workflowToVisualState', () => {
	it('creates one node per step', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.nodes).toHaveLength(2);
		expect(state.nodes[0].step.id).toBe('s1');
		expect(state.nodes[1].step.id).toBe('s2');
	});

	it('creates one edge per transition', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2'), makeStep('s3')],
			transitions: [makeTransition('s1', 's2'), makeTransition('s2', 's3')],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.edges).toHaveLength(2);
		expect(state.edges[0]).toMatchObject({ fromStepKey: 's1', toStepKey: 's2' });
		expect(state.edges[1]).toMatchObject({ fromStepKey: 's2', toStepKey: 's3' });
	});

	it('passes startStepId through unchanged', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's2',
		});
		const state = workflowToVisualState(wf);
		expect(state.startStepId).toBe('s2');
	});

	it('falls back to first step when startStepId does not match any step', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1')],
			transitions: [],
			startStepId: 'nonexistent',
		});
		const state = workflowToVisualState(wf);
		expect(state.startStepId).toBe('s1');
	});

	it('restores positions from workflow.layout', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
			layout: { s1: { x: 100, y: 200 }, s2: { x: 350, y: 200 } },
		});
		const state = workflowToVisualState(wf);
		expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 100, y: 200 });
		expect(state.nodes.find((n) => n.step.id === 's2')?.position).toEqual({ x: 350, y: 200 });
	});

	it('uses autoLayout when no layout is provided', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		// Positions should be non-zero values from autoLayout
		const s1 = state.nodes.find((n) => n.step.id === 's1')!;
		const s2 = state.nodes.find((n) => n.step.id === 's2')!;
		expect(s1.position.y).toBeLessThan(s2.position.y); // s2 is below s1 in a linear chain
	});

	it('uses autoLayout for steps missing from partial layout', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
			layout: { s1: { x: 999, y: 888 } }, // s2 not in layout
		});
		const state = workflowToVisualState(wf);
		const s1 = state.nodes.find((n) => n.step.id === 's1')!;
		const s2 = state.nodes.find((n) => n.step.id === 's2')!;
		// s1 uses stored position
		expect(s1.position).toEqual({ x: 999, y: 888 });
		// s2 falls back to autoLayout (non-zero from algorithm)
		expect(s2.position).toBeDefined();
	});

	it('maps condition types correctly', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2'), makeStep('s3')],
			transitions: [
				makeTransition('s1', 's2', 't1', 0, { type: 'human' }),
				makeTransition('s2', 's3', 't2', 1, { type: 'condition', expression: 'exit 0' }),
			],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.edges[0].condition).toEqual({ type: 'human' });
		expect(state.edges[1].condition).toEqual({ type: 'condition', expression: 'exit 0' });
	});

	it('maps transitions without condition to always', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.edges[0].condition).toEqual({ type: 'always' });
	});

	it('converts rules to drafts', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1')],
			transitions: [],
			startStepId: 's1',
			rules: [makeRule('r1', 'Rule 1', 'Content 1', ['s1'])],
		});
		const state = workflowToVisualState(wf);
		expect(state.rules).toHaveLength(1);
		expect(state.rules[0].id).toBe('r1');
		expect(state.rules[0].name).toBe('Rule 1');
		expect(state.rules[0].appliesTo).toContain('s1');
	});

	it('passes tags through', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1')],
			transitions: [],
			startStepId: 's1',
			tags: ['coding', 'review'],
		});
		const state = workflowToVisualState(wf);
		expect(state.tags).toEqual(['coding', 'review']);
	});

	it('assigns fresh localIds to each node', () => {
		const wf = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [],
			startStepId: 's1',
		});
		const state = workflowToVisualState(wf);
		const localIds = state.nodes.map((n) => n.step.localId);
		expect(new Set(localIds).size).toBe(2); // all unique
	});
});

// ---------------------------------------------------------------------------
// visualStateToCreateParams
// ---------------------------------------------------------------------------

describe('visualStateToCreateParams', () => {
	function makeState(overrides: Partial<VisualEditorState> = {}): VisualEditorState {
		return {
			nodes: [
				{
					step: { localId: 'local-1', id: 's1', name: 'Step 1', agentId: 'a1', instructions: '' },
					position: { x: 50, y: 50 },
				},
				{
					step: {
						localId: 'local-2',
						id: 's2',
						name: 'Step 2',
						agentId: 'a2',
						instructions: 'do work',
					},
					position: { x: 300, y: 50 },
				},
			],
			edges: [
				{
					fromStepKey: 's1',
					toStepKey: 's2',
					condition: { type: 'always' },
				},
			],
			startStepId: 's1',
			rules: [],
			tags: [],
			...overrides,
		};
	}

	it('produces correct steps array', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.steps).toHaveLength(2);
		expect(params.steps![0]).toMatchObject({ id: 's1', name: 'Step 1', agentId: 'a1' });
		expect(params.steps![1]).toMatchObject({
			id: 's2',
			name: 'Step 2',
			agentId: 'a2',
			instructions: 'do work',
		});
	});

	it('omits empty instructions', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.steps![0].instructions).toBeUndefined();
	});

	it('produces correct transitions array', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.transitions).toHaveLength(1);
		expect(params.transitions![0]).toMatchObject({ from: 's1', to: 's2', order: 0 });
	});

	it('omits condition when type is always', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.transitions![0].condition).toBeUndefined();
	});

	it('includes condition when type is not always', () => {
		const state = makeState({
			edges: [{ fromStepKey: 's1', toStepKey: 's2', condition: { type: 'human' } }],
		});
		const params = visualStateToCreateParams(state, 'space-1', 'My Workflow');
		expect(params.transitions![0].condition).toMatchObject({ type: 'human' });
	});

	it('passes startStepId through', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.startStepId).toBe('s1');
	});

	it('builds layout from node positions', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.layout).toMatchObject({
			s1: { x: 50, y: 50 },
			s2: { x: 300, y: 50 },
		});
	});

	it('passes spaceId, name, description', () => {
		const params = visualStateToCreateParams(makeState(), 'space-42', 'Cool WF', 'A description');
		expect(params.spaceId).toBe('space-42');
		expect(params.name).toBe('Cool WF');
		expect(params.description).toBe('A description');
	});

	it('includes tags', () => {
		const params = visualStateToCreateParams(makeState({ tags: ['coding'] }), 'space-1', 'WF');
		expect(params.tags).toEqual(['coding']);
	});

	it('includes rules without id field', () => {
		const state = makeState({
			rules: [
				{
					localId: 'lr1',
					id: undefined,
					name: 'My Rule',
					content: 'Content',
					appliesTo: ['s1'],
				},
			],
		});
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.rules).toHaveLength(1);
		expect(params.rules![0]).not.toHaveProperty('id');
		expect(params.rules![0].name).toBe('My Rule');
	});

	it('generates a new UUID for steps without id', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'local-new', name: 'New Step', agentId: 'a1', instructions: '' },
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startStepId: 'local-new',
			rules: [],
			tags: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.steps![0].id).toBeTruthy();
		expect(params.startStepId).toBe(params.steps![0].id);
	});
});

// ---------------------------------------------------------------------------
// Transition order: left-to-right by target x-position
// ---------------------------------------------------------------------------

describe('transition ordering', () => {
	it('orders multiple outgoing transitions by target x-position', () => {
		// Source node s1 has two outgoing edges: to s2 (x=400) and s3 (x=100)
		// s3 is to the LEFT of s2 so should get order=0
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 200, y: 0 },
				},
				{
					step: { localId: 'l2', id: 's2', name: 'S2', agentId: 'a', instructions: '' },
					position: { x: 400, y: 150 },
				},
				{
					step: { localId: 'l3', id: 's3', name: 'S3', agentId: 'a', instructions: '' },
					position: { x: 100, y: 150 },
				},
			],
			edges: [
				{ fromStepKey: 's1', toStepKey: 's2', condition: { type: 'always' } },
				{ fromStepKey: 's1', toStepKey: 's3', condition: { type: 'always' } },
			],
			startStepId: 's1',
			rules: [],
			tags: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		const t = params.transitions!;
		// Find transitions from s1
		const fromS1 = t
			.filter((tr) => tr.from === 's1')
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		expect(fromS1).toHaveLength(2);
		// order=0 should go to s3 (leftmost), order=1 to s2
		expect(fromS1[0].to).toBe('s3');
		expect(fromS1[0].order).toBe(0);
		expect(fromS1[1].to).toBe('s2');
		expect(fromS1[1].order).toBe(1);
	});

	it('preserves single outgoing edge with order=0', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 0, y: 0 },
				},
				{
					step: { localId: 'l2', id: 's2', name: 'S2', agentId: 'a', instructions: '' },
					position: { x: 250, y: 150 },
				},
			],
			edges: [{ fromStepKey: 's1', toStepKey: 's2', condition: { type: 'always' } }],
			startStepId: 's1',
			rules: [],
			tags: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.transitions![0].order).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Round-trip: workflowToVisualState -> visualStateToUpdateParams
// ---------------------------------------------------------------------------

describe('round-trip serialization', () => {
	it('produces equivalent steps after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1', 'Plan', 'agent-p'), makeStep('s2', 'Code', 'agent-c')],
			transitions: [makeTransition('s1', 's2', 't1', 0)],
			startStepId: 's1',
			layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 } },
			tags: ['coding'],
		});

		const visualState = workflowToVisualState(original);
		const params = visualStateToUpdateParams(visualState);

		expect(params.steps).toHaveLength(2);
		expect(params.steps![0]).toMatchObject({ id: 's1', name: 'Plan', agentId: 'agent-p' });
		expect(params.steps![1]).toMatchObject({ id: 's2', name: 'Code', agentId: 'agent-c' });
	});

	it('preserves startStepId after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's2',
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.startStepId).toBe('s2');
	});

	it('preserves layout positions after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
			layout: { s1: { x: 111, y: 222 }, s2: { x: 333, y: 444 } },
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.layout).toMatchObject({
			s1: { x: 111, y: 222 },
			s2: { x: 333, y: 444 },
		});
	});

	it('preserves transition conditions after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [
				makeTransition('s1', 's2', 't1', 0, {
					type: 'condition',
					expression: 'test -f output.txt',
				}),
			],
			startStepId: 's1',
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.transitions![0].condition).toMatchObject({
			type: 'condition',
			expression: 'test -f output.txt',
		});
	});

	it('preserves tags after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1')],
			transitions: [],
			startStepId: 's1',
			tags: ['research', 'review'],
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.tags).toEqual(['research', 'review']);
	});

	it('preserves rules after round-trip', () => {
		const original = makeWorkflow({
			steps: [makeStep('s1'), makeStep('s2')],
			transitions: [makeTransition('s1', 's2')],
			startStepId: 's1',
			rules: [makeRule('r1', 'Security Rule', 'No secrets in output', ['s1'])],
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.rules).toHaveLength(1);
		expect(params.rules![0]).toMatchObject({
			id: 'r1',
			name: 'Security Rule',
			content: 'No secrets in output',
		});
		expect(params.rules![0].appliesTo).toContain('s1');
	});

	it('is lossless for a 3-step workflow with all features', () => {
		const original = makeWorkflow({
			steps: [
				makeStep('s1', 'Plan', 'agent-p'),
				makeStep('s2', 'Code', 'agent-c'),
				makeStep('s3', 'Review', 'agent-r'),
			],
			transitions: [
				makeTransition('s1', 's2', 't1', 0, { type: 'human' }),
				makeTransition('s2', 's3', 't2', 0),
			],
			startStepId: 's1',
			layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 }, s3: { x: 50, y: 350 } },
			tags: ['coding'],
			rules: [makeRule('r1', 'R1', 'Content', ['s1', 's2'])],
		});

		const visualState = workflowToVisualState(original);
		const params = visualStateToUpdateParams(visualState);

		// Steps
		expect(params.steps).toHaveLength(3);
		const stepIds = params.steps!.map((s) => s.id);
		expect(stepIds).toContain('s1');
		expect(stepIds).toContain('s2');
		expect(stepIds).toContain('s3');

		// Transitions
		expect(params.transitions).toHaveLength(2);
		const t1 = params.transitions!.find((t) => t.from === 's1' && t.to === 's2')!;
		expect(t1.condition).toMatchObject({ type: 'human' });
		const t2 = params.transitions!.find((t) => t.from === 's2' && t.to === 's3')!;
		expect(t2.condition).toBeUndefined();

		// startStepId
		expect(params.startStepId).toBe('s1');

		// Layout
		expect(params.layout).toMatchObject({
			s1: { x: 50, y: 50 },
			s2: { x: 50, y: 200 },
			s3: { x: 50, y: 350 },
		});

		// Tags
		expect(params.tags).toEqual(['coding']);

		// Rules
		expect(params.rules![0]).toMatchObject({ id: 'r1', name: 'R1', content: 'Content' });
		expect(params.rules![0].appliesTo).toContain('s1');
		expect(params.rules![0].appliesTo).toContain('s2');
	});
});

// ---------------------------------------------------------------------------
// visualStateToUpdateParams specifics
// ---------------------------------------------------------------------------

describe('visualStateToUpdateParams', () => {
	it('applies name/description overrides', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startStepId: 's1',
			rules: [],
			tags: [],
		};
		const params = visualStateToUpdateParams(state, {
			name: 'Updated Name',
			description: 'New desc',
		});
		expect(params.name).toBe('Updated Name');
		expect(params.description).toBe('New desc');
	});

	it('rules include generated IDs for new rules', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startStepId: 's1',
			rules: [
				{ localId: 'lr1', id: undefined, name: 'New Rule', content: 'Content', appliesTo: [] },
			],
			tags: [],
		};
		const params = visualStateToUpdateParams(state);
		expect(params.rules![0].id).toBeTruthy();
	});
});
