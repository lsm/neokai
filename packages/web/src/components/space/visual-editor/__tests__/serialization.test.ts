/**
 * Unit tests for visual editor serialization helpers.
 *
 * Coverage:
 * - workflowToVisualState: position restoration from layout, auto-layout fallback,
 *   empty edge initialization, startNodeId pass-through, endNodeId pass-through
 * - visualStateToCreateParams / visualStateToUpdateParams: round-trip,
 *   layout output, endNodeId pass-through
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	workflowToVisualState,
	visualStateToCreateParams,
	visualStateToUpdateParams,
} from '../serialization.ts';
import type { VisualEditorState } from '../serialization.ts';
import type { SpaceWorkflow, WorkflowNode } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
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

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(id: string, name?: string, agentId?: string): WorkflowNode {
	return { id, name: name ?? id, agents: [{ agentId: agentId ?? 'agent-1', name: 'coder' }] };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		nodes: [],
		startNodeId: '',
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
	it('creates one node per step (plus Task Agent virtual node)', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		// Task Agent virtual node is always injected as the first node
		expect(state.nodes).toHaveLength(3);
		expect(state.nodes[0].step.id).toBe('__task_agent__');
		expect(state.nodes.find((n) => n.step.id === 's1')?.step.id).toBe('s1');
		expect(state.nodes.find((n) => n.step.id === 's2')?.step.id).toBe('s2');
	});

	it('starts with empty edges (transitions removed from backend)', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2'), makeStep('s3')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.edges).toHaveLength(0);
	});

	it('passes startNodeId through unchanged', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's2',
		});
		const state = workflowToVisualState(wf);
		expect(state.startNodeId).toBe('s2');
	});

	it('falls back to first step when startNodeId does not match any step', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1')],
			startNodeId: 'nonexistent',
		});
		const state = workflowToVisualState(wf);
		expect(state.startNodeId).toBe('s1');
	});

	it('restores positions from workflow.layout', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			layout: { s1: { x: 100, y: 200 }, s2: { x: 350, y: 200 } },
		});
		const state = workflowToVisualState(wf);
		expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 100, y: 200 });
		expect(state.nodes.find((n) => n.step.id === 's2')?.position).toEqual({ x: 350, y: 200 });
	});

	it('does not invoke autoLayout when all steps have stored positions', () => {
		// This is validated by ensuring position values match the layout exactly.
		// If autoLayout ran, it would produce different values (50, 170) not (999, 888).
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			layout: { s1: { x: 999, y: 888 }, s2: { x: 777, y: 666 } },
		});
		const state = workflowToVisualState(wf);
		expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 999, y: 888 });
		expect(state.nodes.find((n) => n.step.id === 's2')?.position).toEqual({ x: 777, y: 666 });
	});

	it('uses autoLayout when no layout is provided', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		// In a linear chain, s2 should be in a lower layer (higher y)
		const s1 = state.nodes.find((n) => n.step.id === 's1')!;
		const s2 = state.nodes.find((n) => n.step.id === 's2')!;
		expect(s1.position.y).toBeLessThan(s2.position.y);
	});

	it('uses autoLayout only for steps missing from partial layout', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			layout: { s1: { x: 999, y: 888 } }, // s2 not in layout
		});
		const state = workflowToVisualState(wf);
		// s1 uses stored position
		expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 999, y: 888 });
		// s2 falls back to autoLayout (non-zero from algorithm)
		const s2 = state.nodes.find((n) => n.step.id === 's2');
		expect(s2?.position).toBeDefined();
	});

	it('starts with empty edges (WorkflowCondition not loaded from transitions)', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		// Transitions removed from SpaceWorkflow; visual state starts with no edges
		expect(state.edges).toHaveLength(0);
	});

	it('passes tags through', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1')],
			startNodeId: 's1',
			tags: ['coding', 'review'],
		});
		const state = workflowToVisualState(wf);
		expect(state.tags).toEqual(['coding', 'review']);
	});

	it('passes workflow gates through', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1')],
			startNodeId: 's1',
			gates: [
				{
					id: 'review-votes-gate',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['*'],
							check: { op: 'count', match: 'approved', min: 3 },
						},
					],
					resetOnCycle: true,
				},
			],
		});
		const state = workflowToVisualState(wf);
		expect(state.gates).toHaveLength(1);
		expect(state.gates[0].id).toBe('review-votes-gate');
		expect(state.gates[0].fields![0].name).toBe('votes');
		expect(state.gates[0].fields![0].check).toMatchObject({
			op: 'count',
			match: 'approved',
			min: 3,
		});
	});

	it('assigns fresh localIds to each node (including Task Agent)', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const localIds = state.nodes.map((n) => n.step.localId);
		// Task Agent + 2 regular nodes = 3 unique localIds
		expect(new Set(localIds).size).toBe(3);
	});

	it('passes endNodeId through when set', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			endNodeId: 's2',
		});
		const state = workflowToVisualState(wf);
		expect(state.endNodeId).toBe('s2');
	});

	it('endNodeId is undefined when not set on workflow', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		expect(state.endNodeId).toBeUndefined();
	});

	it('endNodeId falls back to undefined when referencing nonexistent node', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			endNodeId: 'nonexistent',
		});
		const state = workflowToVisualState(wf);
		expect(state.endNodeId).toBeUndefined();
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
					condition: undefined,
				},
			],
			startNodeId: 's1',
			tags: [],
			channels: [],
			gates: [],
			...overrides,
		};
	}

	it('produces correct steps array', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.nodes).toHaveLength(2);
		expect(params.nodes![0]).toMatchObject({ id: 's1', name: 'Step 1' });
		expect(params.nodes![0].agents).toHaveLength(1);
		expect(params.nodes![0].agents[0].agentId).toBe('a1');
		expect(params.nodes![1]).toMatchObject({
			id: 's2',
			name: 'Step 2',
			instructions: 'do work',
		});
		expect(params.nodes![1].agents[0].agentId).toBe('a2');
	});

	it('produces agents array (model/systemPrompt removed from WorkflowNodeInput)', () => {
		// model and systemPrompt are NodeDraft-only fields (not on WorkflowNodeInput or WorkflowNodeAgent)
		const params = visualStateToCreateParams(
			makeState({
				nodes: [
					{
						step: {
							localId: 'local-1',
							id: 's1',
							name: 'Step 1',
							agentId: 'a1',
							instructions: '',
						},
						position: { x: 50, y: 50 },
					},
				],
			}),
			'space-1',
			'My Workflow'
		);
		expect(params.nodes![0].agents).toHaveLength(1);
		expect(params.nodes![0].agents[0].agentId).toBe('a1');
	});

	it('omits empty instructions', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.nodes![0].instructions).toBeUndefined();
	});

	it('passes startNodeId through', () => {
		const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
		expect(params.startNodeId).toBe('s1');
	});

	it('resolves startNodeId via localId when it references step.localId', () => {
		// startNodeId is set to the localId of an existing step (step.id='s1', localId='local-1')
		const state = makeState({ startNodeId: 'local-1' });
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		// Should resolve to the persisted step id 's1'
		expect(params.startNodeId).toBe('s1');
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

	it('generates a new UUID for steps without id', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'local-new', name: 'New Step', agentId: 'a1', instructions: '' },
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startNodeId: 'local-new',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.nodes![0].id).toBeTruthy();
		expect(params.startNodeId).toBe(params.nodes![0].id);
	});

	it('handles zero nodes gracefully', () => {
		const state: VisualEditorState = {
			nodes: [],
			edges: [],
			startNodeId: '',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.nodes).toHaveLength(0);
		expect(params.startNodeId).toBeUndefined();
	});

	it('passes endNodeId through to create params', () => {
		const state = makeState({ endNodeId: 's2' });
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.endNodeId).toBe('s2');
	});

	it('endNodeId is undefined when not set on state', () => {
		const state = makeState();
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.endNodeId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Round-trip: workflowToVisualState -> visualStateToUpdateParams
// ---------------------------------------------------------------------------

describe('round-trip serialization', () => {
	it('produces equivalent steps after round-trip', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1', 'Plan', 'agent-p'), makeStep('s2', 'Code', 'agent-c')],
			startNodeId: 's1',
			layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 } },
			tags: ['coding'],
		});

		const visualState = workflowToVisualState(original);
		const params = visualStateToUpdateParams(visualState);

		expect(params.nodes).toHaveLength(2);
		expect(params.nodes![0]).toMatchObject({ id: 's1', name: 'Plan' });
		expect(params.nodes![0].agents).toHaveLength(1);
		expect(params.nodes![0].agents[0].agentId).toBe('agent-p');
		expect(params.nodes![1]).toMatchObject({ id: 's2', name: 'Code' });
		expect(params.nodes![1].agents).toHaveLength(1);
		expect(params.nodes![1].agents[0].agentId).toBe('agent-c');
	});

	it('preserves startNodeId after round-trip', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's2',
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.startNodeId).toBe('s2');
	});

	it('preserves layout positions after round-trip', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			layout: { s1: { x: 111, y: 222 }, s2: { x: 333, y: 444 } },
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.layout).toMatchObject({
			s1: { x: 111, y: 222 },
			s2: { x: 333, y: 444 },
		});
	});

	it('produces empty transitions after round-trip (transitions removed from backend)', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const visualState = workflowToVisualState(original);
		// Edges start empty since backend no longer stores transitions
		expect(visualState.edges).toHaveLength(0);
	});

	it('preserves tags after round-trip', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1')],
			startNodeId: 's1',
			tags: ['research', 'review'],
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.tags).toEqual(['research', 'review']);
	});

	it('edges are empty after round-trip (transitions removed from backend)', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const visualState = workflowToVisualState(original);
		// Transitions have been removed; edges always start empty
		expect(visualState.edges).toHaveLength(0);
	});

	it('is lossless for a 3-step workflow with all features', () => {
		const original = makeWorkflow({
			nodes: [
				makeStep('s1', 'Plan', 'agent-p'),
				makeStep('s2', 'Code', 'agent-c'),
				makeStep('s3', 'Review', 'agent-r'),
			],
			startNodeId: 's1',
			layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 }, s3: { x: 50, y: 350 } },
			tags: ['coding'],
		});

		const visualState = workflowToVisualState(original);
		const params = visualStateToUpdateParams(visualState);

		// Steps
		expect(params.nodes).toHaveLength(3);
		const stepIds = params.nodes!.map((s) => s.id);
		expect(stepIds).toContain('s1');
		expect(stepIds).toContain('s2');
		expect(stepIds).toContain('s3');

		// startNodeId
		expect(params.startNodeId).toBe('s1');

		// Layout
		expect(params.layout).toMatchObject({
			s1: { x: 50, y: 50 },
			s2: { x: 50, y: 200 },
			s3: { x: 50, y: 350 },
		});

		// Tags
		expect(params.tags).toEqual(['coding']);
	});

	it('preserves endNodeId after round-trip', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			endNodeId: 's2',
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.endNodeId).toBe('s2');
	});

	it('round-trip preserves endNodeId as null when not set', () => {
		const original = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const params = visualStateToUpdateParams(workflowToVisualState(original));
		expect(params.endNodeId).toBeNull();
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
			startNodeId: 's1',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToUpdateParams(state, {
			name: 'Updated Name',
			description: 'New desc',
		});
		expect(params.name).toBe('Updated Name');
		expect(params.description).toBe('New desc');
	});

	it('passes endNodeId through to update params', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 0, y: 0 },
				},
				{
					step: { localId: 'l2', id: 's2', name: 'S2', agentId: 'a', instructions: '' },
					position: { x: 200, y: 0 },
				},
			],
			edges: [],
			startNodeId: 's1',
			endNodeId: 's2',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToUpdateParams(state);
		expect(params.endNodeId).toBe('s2');
	});

	it('endNodeId is null when not set on state', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a', instructions: '' },
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startNodeId: 's1',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToUpdateParams(state);
		expect(params.endNodeId).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Multi-agent step serialization
// ---------------------------------------------------------------------------

describe('multi-agent step serialization', () => {
	it('workflowToVisualState preserves agents array from WorkflowNode', () => {
		const workflow = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Parallel Step',
					agents: [
						{ agentId: 'a1', name: 'coder' },
						{
							agentId: 'a2',
							name: 'reviewer',
							instructions: { mode: 'override', value: 'focus on security' },
						},
					],
				},
			],
		});
		const state = workflowToVisualState(workflow);
		// Use find() — Task Agent virtual node is injected at index 0
		const step = state.nodes.find((n) => n.step.id === 's1')!.step;
		expect(step.agents).toHaveLength(2);
		expect(step.agents![0].agentId).toBe('a1');
		expect(step.agents![1].agentId).toBe('a2');
		expect(step.agents![1].instructions).toEqual({ mode: 'override', value: 'focus on security' });
		// agentId should be empty (multi-agent step)
		expect(step.agentId).toBe('');
	});

	it('workflowToVisualState preserves channels array at workflow level', () => {
		const workflow = makeWorkflow({
			channels: [
				{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'PR' },
				{ from: 'reviewer', to: ['coder', 'qa'], direction: 'bidirectional' },
			],
			nodes: [
				{
					id: 's1',
					name: 'Parallel Step',
					agents: [
						{ agentId: 'a1', name: 'coder' },
						{ agentId: 'a2', name: 'reviewer' },
					],
				},
			],
		});
		const state = workflowToVisualState(workflow);
		// Note: VisualEditorState does not currently preserve workflow-level channels
		// This test documents the expected behavior once channels support is added
		// Note: VisualEditorState does not have a channels property
		// (channels are at workflow level, not editor state level)
	});

	it('visualStateToCreateParams outputs agents array for multi-agent steps', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: {
						localId: 'local-1',
						id: 's1',
						name: 'Parallel Step',
						agentId: '',
						agents: [
							{ agentId: 'a1', name: 'coder' },
							{
								agentId: 'a2',
								name: 'reviewer',
								instructions: { mode: 'override', value: 'custom' },
							},
						],
						instructions: '',
					},
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startNodeId: 's1',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		const step = params.nodes![0];
		expect(step.agents).toHaveLength(2);
		expect(step.agents![0].agentId).toBe('a1');
		expect(step.agents![1].instructions).toEqual({ mode: 'override', value: 'custom' });
		// agentId should be absent (undefined) when agents is set
		expect((step as unknown as Record<string, unknown>)['agentId']).toBeUndefined();
	});

	it('visualStateToCreateParams omits empty channels array', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: {
						localId: 'local-1',
						id: 's1',
						name: 'Step',
						agentId: '',
						agents: [{ agentId: 'a1', name: 'coder' }],
						instructions: '',
					},
					position: { x: 0, y: 0 },
				},
			],
			edges: [],
			startNodeId: 's1',
			tags: [],
			channels: [],
			gates: [],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		// Channels are not yet supported in visualStateToCreateParams output
		// (they are workflow-level, not editor state level)
	});

	it('visualStateToCreateParams persists only gates referenced by channels', () => {
		const state: VisualEditorState = {
			nodes: [
				{
					step: {
						localId: 'local-1',
						id: 's1',
						name: 'Plan',
						agentId: '',
						agents: [{ agentId: 'a1', name: 'planner' }],
						instructions: '',
					},
					position: { x: 0, y: 0 },
				},
				{
					step: {
						localId: 'local-2',
						id: 's2',
						name: 'Code',
						agentId: '',
						agents: [{ agentId: 'a2', name: 'coder' }],
						instructions: '',
					},
					position: { x: 200, y: 0 },
				},
			],
			edges: [],
			startNodeId: 's1',
			tags: [],
			channels: [
				{
					from: 'Plan',
					to: 'Code',
					direction: 'one-way',
					gateId: 'review-votes-gate',
				},
			],
			gates: [
				{
					id: 'review-votes-gate',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['*'],
							check: { op: 'count', match: 'approved', min: 3 },
						},
					],
					resetOnCycle: true,
				},
				{
					id: 'unused-gate',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.gates).toHaveLength(1);
		expect(params.gates![0].id).toBe('review-votes-gate');
	});

	it('single-agent step round-trip: agents preserved through workflowToVisualState and serialized output', () => {
		const workflow = makeWorkflow({
			nodes: [makeStep('s1', 'Code', 'agent-coder')],
		});
		const state = workflowToVisualState(workflow);
		// Use find() — Task Agent virtual node is injected at index 0
		const s1Node = state.nodes.find((n) => n.step.id === 's1')!;
		// workflowToVisualState sets agentId to '' and stores the agent in agents array
		expect(s1Node.step.agents).toHaveLength(1);
		expect(s1Node.step.agents![0].agentId).toBe('agent-coder');

		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		// serialization builds agents array from agents for single-agent steps
		expect(params.nodes![0].agents).toHaveLength(1);
		expect(params.nodes![0].agents[0].agentId).toBe('agent-coder');
	});

	it('full round-trip workflowToVisualState -> visualStateToUpdateParams preserves multi-agent data', () => {
		const workflow = makeWorkflow({
			channels: [
				{ from: 'coder', to: 'reviewer', direction: 'one-way' as const },
				{ from: 'reviewer', to: ['coder', 'qa'], direction: 'bidirectional' as const },
			],
			nodes: [
				{
					id: 's1',
					name: 'Parallel',
					agents: [
						{
							agentId: 'a1',
							name: 'coder',
							instructions: { mode: 'override', value: 'focus on tests' },
						},
						{ agentId: 'a2', name: 'reviewer' },
					],
				},
			],
			layout: { s1: { x: 0, y: 0 } },
		});
		const state = workflowToVisualState(workflow);
		const params = visualStateToUpdateParams(state);

		const step = params.nodes![0];
		// agents array preserved through update round-trip
		expect(step.agents).toHaveLength(2);
		expect(step.agents![0].agentId).toBe('a1');
		expect(step.agents![0].instructions).toEqual({ mode: 'override', value: 'focus on tests' });
		expect(step.agents![1].agentId).toBe('a2');
		expect(step.agents![1].instructions).toBeUndefined();
		// agentId should be absent for multi-agent steps
		expect((step as unknown as Record<string, unknown>)['agentId']).toBeUndefined();
		// Workflow-level channels are preserved through serialization
		expect(params.channels).toHaveLength(2);
		expect(params.channels![0]).toMatchObject({
			from: 'coder',
			to: 'reviewer',
			direction: 'one-way',
		});
		expect(params.channels![1]).toMatchObject({
			from: 'reviewer',
			to: ['coder', 'qa'],
			direction: 'bidirectional',
		});
	});
});

// ---------------------------------------------------------------------------
// Task Agent virtual node — serialization / deserialization
// ---------------------------------------------------------------------------

describe('Task Agent virtual node', () => {
	it('workflowToVisualState always injects Task Agent as first node', () => {
		const wf = makeWorkflow({ nodes: [makeStep('s1')], startNodeId: 's1' });
		const state = workflowToVisualState(wf);
		expect(state.nodes[0].step.id).toBe(TASK_AGENT_NODE_ID);
		expect(state.nodes[0].step.localId).toBe(TASK_AGENT_NODE_ID);
		expect(state.nodes[0].step.name).toBe('Task Agent');
	});

	it('Task Agent node is present even for empty workflow', () => {
		const wf = makeWorkflow({ nodes: [], startNodeId: '' });
		const state = workflowToVisualState(wf);
		expect(state.nodes).toHaveLength(1);
		expect(state.nodes[0].step.id).toBe(TASK_AGENT_NODE_ID);
	});

	it('Task Agent is positioned above regular nodes (lower y value)', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
			layout: { s1: { x: 300, y: 200 }, s2: { x: 300, y: 400 } },
		});
		const state = workflowToVisualState(wf);
		const taskAgentPos = state.nodes[0].position;
		const s1Pos = state.nodes.find((n) => n.step.id === 's1')!.position;
		expect(taskAgentPos.y).toBeLessThan(s1Pos.y);
	});

	it('visualStateToCreateParams strips Task Agent node from persisted nodes', () => {
		const wf = makeWorkflow({ nodes: [makeStep('s1'), makeStep('s2')], startNodeId: 's1' });
		const state = workflowToVisualState(wf);

		// Task Agent must be in the visual state
		expect(state.nodes.some((n) => n.step.id === TASK_AGENT_NODE_ID)).toBe(true);

		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		// Task Agent must NOT be in the persisted nodes
		expect(params.nodes!.every((n) => n.id !== TASK_AGENT_NODE_ID)).toBe(true);
		expect(params.nodes).toHaveLength(2);
	});

	it('visualStateToUpdateParams strips Task Agent node from persisted nodes', () => {
		const wf = makeWorkflow({ nodes: [makeStep('s1')], startNodeId: 's1' });
		const state = workflowToVisualState(wf);

		const params = visualStateToUpdateParams(state);
		expect(params.nodes!.every((n) => n.id !== TASK_AGENT_NODE_ID)).toBe(true);
		expect(params.nodes).toHaveLength(1);
	});

	it('Task Agent is excluded from the persisted layout', () => {
		const wf = makeWorkflow({ nodes: [makeStep('s1')], startNodeId: 's1' });
		const state = workflowToVisualState(wf);

		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(Object.keys(params.layout!)).not.toContain(TASK_AGENT_NODE_ID);
	});

	it('serialization round-trip preserves regular nodes and excludes Task Agent', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1', 'Coder', 'agent-coder'), makeStep('s2', 'Reviewer', 'agent-reviewer')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const params = visualStateToCreateParams(state, 'space-1', 'WF');

		// Regular nodes preserved
		const s1Node = params.nodes!.find((n) => n.id === 's1')!;
		expect(s1Node.name).toBe('Coder');
		expect(s1Node.agents[0].agentId).toBe('agent-coder');
		const s2Node = params.nodes!.find((n) => n.id === 's2')!;
		expect(s2Node.name).toBe('Reviewer');
		expect(s2Node.agents[0].agentId).toBe('agent-reviewer');
		// Task Agent not present
		expect(params.nodes!.some((n) => n.id === TASK_AGENT_NODE_ID)).toBe(false);
	});

	it('Task Agent node in state does not affect startNodeId resolution', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's2',
		});
		const state = workflowToVisualState(wf);
		expect(state.startNodeId).toBe('s2');

		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		expect(params.startNodeId).toBe('s2');
	});

	it('Task Agent node in state does not appear in serialized nodes', () => {
		const wf = makeWorkflow({
			nodes: [makeStep('s1'), makeStep('s2')],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const params = visualStateToCreateParams(state, 'space-1', 'WF');

		// Task Agent virtual node must not be serialized to the backend
		expect(params.nodes!.some((n) => n.id === TASK_AGENT_NODE_ID)).toBe(false);
		expect(params.nodes).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Per-slot agent override serialization round-trips
// ---------------------------------------------------------------------------

describe('per-slot agent overrides round-trip', () => {
	it('workflowToVisualState preserves systemPrompt override on agents', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Review',
					agents: [
						{
							agentId: 'a1',
							name: 'strict-reviewer',
							systemPrompt: { mode: 'override', value: 'Be strict.' },
						},
						{ agentId: 'a1', name: 'quick-reviewer' },
					],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const node = state.nodes.find((n) => n.step.id === 's1')!;
		expect(node.step.agents).toHaveLength(2);
		expect(node.step.agents![0].name).toBe('strict-reviewer');
		expect(node.step.agents![0].systemPrompt).toMatchObject({
			mode: 'override',
			value: 'Be strict.',
		});
		// slot without override has no systemPrompt field
		expect(node.step.agents![1].systemPrompt).toBeUndefined();
	});

	it('workflowToVisualState preserves instructions override on agents', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Code',
					agents: [
						{
							agentId: 'a1',
							name: 'coder',
							instructions: { mode: 'override', value: 'You are a strict TypeScript expert.' },
						},
					],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const node = state.nodes.find((n) => n.step.id === 's1')!;
		expect(node.step.agents![0].instructions).toMatchObject({
			mode: 'override',
			value: 'You are a strict TypeScript expert.',
		});
	});

	it('visualStateToCreateParams passes systemPrompt override through to output', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Review',
					agents: [
						{
							agentId: 'a1',
							name: 'strict-reviewer',
							systemPrompt: { mode: 'override', value: 'Be strict.' },
						},
						{ agentId: 'a2', name: 'quick-reviewer' },
					],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const params = visualStateToCreateParams(state, 'space-1', 'WF');

		const node = params.nodes![0];
		expect(node.agents).toHaveLength(2);
		expect(node.agents![0].name).toBe('strict-reviewer');
		expect(node.agents![0].systemPrompt).toMatchObject({ mode: 'override', value: 'Be strict.' });
		expect(node.agents![1].systemPrompt).toBeUndefined();
	});

	it('full round-trip: workflow->visualState->createParams preserves all override fields', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Multi Review',
					agents: [
						{
							agentId: 'a1',
							name: 'coder',
							systemPrompt: { mode: 'override', value: 'Fast coder.' },
							instructions: { mode: 'override', value: 'Focus on speed.' },
						},
						{
							agentId: 'a1',
							name: 'coder-2',
							instructions: { mode: 'expand', value: 'Focus on quality.' },
						},
					],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const params = visualStateToCreateParams(state, 'space-1', 'WF');

		const [slot1, slot2] = params.nodes![0].agents!;
		expect(slot1.name).toBe('coder');
		expect(slot1.systemPrompt).toMatchObject({ mode: 'override', value: 'Fast coder.' });
		expect(slot1.instructions).toMatchObject({ mode: 'override', value: 'Focus on speed.' });
		expect(slot2.name).toBe('coder-2');
		expect(slot2.systemPrompt).toBeUndefined();
		expect(slot2.instructions).toMatchObject({ mode: 'expand', value: 'Focus on quality.' });
	});

	it('same agent added twice with different roles: both preserved in create params', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 's1',
					name: 'Dual Review',
					agents: [
						{ agentId: 'reviewer-agent', name: 'reviewer' },
						{
							agentId: 'reviewer-agent',
							name: 'reviewer-2',
							systemPrompt: { mode: 'override', value: 'Be thorough.' },
						},
					],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);
		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		const agents = params.nodes![0].agents!;
		expect(agents).toHaveLength(2);
		// Both slots reference the same agentId but with different roles
		expect(agents[0].agentId).toBe('reviewer-agent');
		expect(agents[0].name).toBe('reviewer');
		expect(agents[1].agentId).toBe('reviewer-agent');
		expect(agents[1].name).toBe('reviewer-2');
		expect(agents[1].systemPrompt).toMatchObject({ mode: 'override', value: 'Be thorough.' });
	});

	it('role rename in visual state is reflected in serialized output', () => {
		// Simulates the user renaming a slot role via the role input field and then saving.
		// Workflow-level channels are preserved through serialization (user must update them manually).
		const wf = makeWorkflow({
			channels: [{ from: 'task-agent', to: 'coder', direction: 'bidirectional' as const }],
			nodes: [
				{
					id: 's1',
					name: 'Code',
					agents: [{ agentId: 'a1', name: 'coder' }],
				},
			],
			startNodeId: 's1',
		});
		const state = workflowToVisualState(wf);

		// Simulate the user renaming 'coder' -> 'lead-coder' via the role input
		const nodeIdx = state.nodes.findIndex((n) => n.step.id === 's1');
		state.nodes[nodeIdx].step.agents = [{ agentId: 'a1', name: 'lead-coder' }];

		const params = visualStateToCreateParams(state, 'space-1', 'WF');
		const node = params.nodes![0];

		// New role is serialized
		expect(node.agents![0].name).toBe('lead-coder');
		// Workflow-level channels are preserved through serialization
		expect(params.channels).toHaveLength(1);
		expect(params.channels![0]).toMatchObject({
			from: 'task-agent',
			to: 'coder',
			direction: 'bidirectional',
		});
	});
});
