/**
 * Unit tests for the DAG auto-layout algorithm.
 *
 * Note: autoLayout always injects the Task Agent virtual node (TASK_AGENT_NODE_ID)
 * pinned at the top-center of the canvas. All `result.size` assertions include this
 * virtual node (+1 compared to the count of workflow nodes passed in).
 */

import { describe, it, expect } from 'vitest';
import { autoLayout } from '../layout.ts';
import type { WorkflowNode, WorkflowTransition } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string): WorkflowNode {
	return { id, name: id, agentId: 'agent-1' };
}

function makeTransition(from: string, to: string): WorkflowTransition {
	return { id: `${from}->${to}`, from, to };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoLayout', () => {
	it('returns a map with only the Task Agent for empty workflow', () => {
		const result = autoLayout([], [], 'start');
		// Even with no regular nodes, the Task Agent virtual node is always added
		expect(result.size).toBe(1);
		expect(result.has(TASK_AGENT_NODE_ID)).toBe(true);
	});

	it('places a single node at the start position', () => {
		const steps = [makeStep('a')];
		const result = autoLayout(steps, [], 'a');
		// Task Agent + 1 regular node
		expect(result.size).toBe(2);
		const pos = result.get('a')!;
		expect(pos).toBeDefined();
		expect(pos.x).toBeGreaterThanOrEqual(0);
		expect(pos.y).toBeGreaterThanOrEqual(0);
	});

	it('Task Agent is pinned above the highest regular node', () => {
		const steps = [makeStep('a'), makeStep('b')];
		const transitions = [makeTransition('a', 'b')];
		const result = autoLayout(steps, transitions, 'a');

		const taskAgentPos = result.get(TASK_AGENT_NODE_ID)!;
		const ya = result.get('a')!.y;
		expect(taskAgentPos).toBeDefined();
		// Task Agent should be above (smaller y) the first regular layer
		expect(taskAgentPos.y).toBeLessThan(ya);
	});

	it('Task Agent is centered horizontally relative to the widest layer', () => {
		const steps = [makeStep('a'), makeStep('b'), makeStep('c')];
		const transitions = [makeTransition('a', 'b'), makeTransition('a', 'c')];
		const result = autoLayout(steps, transitions, 'a');

		const taskAgentPos = result.get(TASK_AGENT_NODE_ID)!;
		const xb = result.get('b')!.x;
		const xc = result.get('c')!.x;
		// Task Agent should be centered between b and c (the widest layer)
		expect(taskAgentPos.x).toBeCloseTo((xb + xc) / 2, 0);
	});

	describe('linear chain layout', () => {
		it('lays out a→b→c as a vertical chain (increasing y, same x)', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('b', 'c')];
			const result = autoLayout(steps, transitions, 'a');

			// Task Agent + 3 regular nodes
			expect(result.size).toBe(4);
			const ya = result.get('a')!.y;
			const yb = result.get('b')!.y;
			const yc = result.get('c')!.y;
			expect(yb).toBeGreaterThan(ya);
			expect(yc).toBeGreaterThan(yb);

			// All in the same x column (centered on a single-node layer)
			const xa = result.get('a')!.x;
			const xb = result.get('b')!.x;
			const xc = result.get('c')!.x;
			expect(xa).toBe(xb);
			expect(xb).toBe(xc);
		});

		it('uses consistent vertical gaps between layers', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('b', 'c')];
			const result = autoLayout(steps, transitions, 'a');

			const ya = result.get('a')!.y;
			const yb = result.get('b')!.y;
			const yc = result.get('c')!.y;
			expect(yb - ya).toBe(yc - yb); // equal spacing
		});
	});

	describe('branching layout', () => {
		it('places siblings at the same y but different x', () => {
			// a → b
			// a → c
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('a', 'c')];
			const result = autoLayout(steps, transitions, 'a');

			// Task Agent + 3 regular nodes
			expect(result.size).toBe(4);
			const yb = result.get('b')!.y;
			const yc = result.get('c')!.y;
			expect(yb).toBe(yc); // same layer → same y

			const xb = result.get('b')!.x;
			const xc = result.get('c')!.x;
			expect(xb).not.toBe(xc); // different x positions
		});

		it('nodes in the same layer do not overlap (x differs by at least H_GAP)', () => {
			const steps = ['a', 'b', 'c', 'd'].map(makeStep);
			// a fans out to b, c, d
			const transitions = [
				makeTransition('a', 'b'),
				makeTransition('a', 'c'),
				makeTransition('a', 'd'),
			];
			const result = autoLayout(steps, transitions, 'a');

			const xs = ['b', 'c', 'd'].map((id) => result.get(id)!.x).sort((a, z) => a - z);
			for (let i = 1; i < xs.length; i++) {
				expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(200); // at least ~H_GAP gap
			}
		});

		it('centering: single-node layers are horizontally centered vs wider layers', () => {
			// Layer 0: [a] (1 node)
			// Layer 1: [b, c] (2 nodes)
			// Layer 2: [d] (1 node)
			const steps = ['a', 'b', 'c', 'd'].map(makeStep);
			const transitions = [
				makeTransition('a', 'b'),
				makeTransition('a', 'c'),
				makeTransition('b', 'd'),
				makeTransition('c', 'd'),
			];
			const result = autoLayout(steps, transitions, 'a');

			const xa = result.get('a')!.x;
			const xb = result.get('b')!.x;
			const xc = result.get('c')!.x;
			const xd = result.get('d')!.x;

			// 'a' should be centered between 'b' and 'c'
			expect(xa).toBeCloseTo((xb + xc) / 2, 0);
			// 'd' should be centered too
			expect(xd).toBeCloseTo((xb + xc) / 2, 0);
		});
	});

	describe('orphaned nodes', () => {
		it('places orphaned nodes below all reachable nodes', () => {
			const steps = ['a', 'b', 'orphan1', 'orphan2'].map(makeStep);
			const transitions = [makeTransition('a', 'b')];
			const result = autoLayout(steps, transitions, 'a');

			// Task Agent + 4 regular nodes
			expect(result.size).toBe(5);
			const maxReachableY = Math.max(result.get('a')!.y, result.get('b')!.y);
			expect(result.get('orphan1')!.y).toBeGreaterThan(maxReachableY);
			expect(result.get('orphan2')!.y).toBeGreaterThan(maxReachableY);
		});

		it('all orphans are placed on the same row', () => {
			const steps = ['a', 'orphan1', 'orphan2', 'orphan3'].map(makeStep);
			const transitions: WorkflowTransition[] = [];
			const result = autoLayout(steps, transitions, 'a');

			// 'a' is reachable (it's the start), orphan1/2/3 are not
			const yo1 = result.get('orphan1')!.y;
			const yo2 = result.get('orphan2')!.y;
			const yo3 = result.get('orphan3')!.y;
			expect(yo1).toBe(yo2);
			expect(yo2).toBe(yo3);
		});

		it('all nodes are assigned positions even with no transitions', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const result = autoLayout(steps, [], 'a');
			// Task Agent + 3 regular nodes
			expect(result.size).toBe(4);
			for (const id of ['a', 'b', 'c']) {
				const pos = result.get(id);
				expect(pos).toBeDefined();
				expect(typeof pos!.x).toBe('number');
				expect(typeof pos!.y).toBe('number');
			}
		});
	});

	describe('cyclic graph handling', () => {
		it('handles a simple two-node cycle without throwing', () => {
			const steps = ['a', 'b'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('b', 'a')];
			expect(() => autoLayout(steps, transitions, 'a')).not.toThrow();
			const result = autoLayout(steps, transitions, 'a');
			// Task Agent + 2 regular nodes
			expect(result.size).toBe(3);
		});

		it('assigns distinct positions to nodes in a cycle', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [
				makeTransition('a', 'b'),
				makeTransition('b', 'c'),
				makeTransition('c', 'a'),
			];
			const result = autoLayout(steps, transitions, 'a');
			// Task Agent + 3 regular nodes
			expect(result.size).toBe(4);
			const positions = [...result.values()];
			// No two nodes share the exact same position
			for (let i = 0; i < positions.length; i++) {
				for (let j = i + 1; j < positions.length; j++) {
					const same = positions[i].x === positions[j].x && positions[i].y === positions[j].y;
					expect(same).toBe(false);
				}
			}
		});

		it('handles a self-loop gracefully', () => {
			const steps = ['a', 'b'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('a', 'a')];
			expect(() => autoLayout(steps, transitions, 'a')).not.toThrow();
			const result = autoLayout(steps, transitions, 'a');
			// Task Agent + 2 regular nodes
			expect(result.size).toBe(3);
		});

		it('handles larger diamond+cycle graph without overlaps', () => {
			// a → b → d
			// a → c → d
			// d → a  (back-edge creating cycle)
			const steps = ['a', 'b', 'c', 'd'].map(makeStep);
			const transitions = [
				makeTransition('a', 'b'),
				makeTransition('a', 'c'),
				makeTransition('b', 'd'),
				makeTransition('c', 'd'),
				makeTransition('d', 'a'),
			];
			expect(() => autoLayout(steps, transitions, 'a')).not.toThrow();
			const result = autoLayout(steps, transitions, 'a');
			// Task Agent + 4 regular nodes
			expect(result.size).toBe(5);

			// No two nodes share the exact same (x, y)
			const positions = [...result.values()];
			for (let i = 0; i < positions.length; i++) {
				for (let j = i + 1; j < positions.length; j++) {
					const same = positions[i].x === positions[j].x && positions[i].y === positions[j].y;
					expect(same).toBe(false);
				}
			}
		});
	});

	describe('edge cases', () => {
		it('start step not in steps list — treats all as orphans', () => {
			const steps = ['a', 'b'].map(makeStep);
			const transitions = [makeTransition('a', 'b')];
			const result = autoLayout(steps, transitions, 'nonexistent');
			// Task Agent + 2 regular nodes (both are orphans, still get positions)
			expect(result.size).toBe(3);
		});

		it('transitions referencing unknown step IDs are ignored', () => {
			const steps = ['a', 'b'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('a', 'zzz')];
			expect(() => autoLayout(steps, transitions, 'a')).not.toThrow();
			const result = autoLayout(steps, transitions, 'a');
			// Task Agent + 2 regular nodes
			expect(result.size).toBe(3);
		});

		it('returns correct positions for a two-step linear workflow', () => {
			const steps = [makeStep('start'), makeStep('end')];
			const transitions = [makeTransition('start', 'end')];
			const result = autoLayout(steps, transitions, 'start');
			// Task Agent + 2 regular nodes
			expect(result.size).toBe(3);
			expect(result.get('start')!.y).toBeLessThan(result.get('end')!.y);
		});
	});
});
