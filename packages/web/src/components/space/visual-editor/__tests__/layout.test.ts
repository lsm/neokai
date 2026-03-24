/**
 * Unit tests for the DAG auto-layout algorithm.
 */

import { describe, it, expect } from 'vitest';
import { autoLayout } from '../layout.ts';
import type { WorkflowNode, WorkflowTransition } from '@neokai/shared';

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
	it('returns empty map for empty workflow', () => {
		const result = autoLayout([], [], 'start');
		expect(result.size).toBe(0);
	});

	it('places a single node at the start position', () => {
		const steps = [makeStep('a')];
		const result = autoLayout(steps, [], 'a');
		expect(result.size).toBe(1);
		const pos = result.get('a')!;
		expect(pos).toBeDefined();
		expect(pos.x).toBeGreaterThanOrEqual(0);
		expect(pos.y).toBeGreaterThanOrEqual(0);
	});

	describe('linear chain layout', () => {
		it('lays out a→b→c as a vertical chain (increasing y, same x)', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('b', 'c')];
			const result = autoLayout(steps, transitions, 'a');

			expect(result.size).toBe(3);
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

			expect(result.size).toBe(3);
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

			expect(result.size).toBe(4);
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
			expect(result.size).toBe(3);
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
			expect(result.size).toBe(2);
		});

		it('assigns distinct positions to nodes in a cycle', () => {
			const steps = ['a', 'b', 'c'].map(makeStep);
			const transitions = [
				makeTransition('a', 'b'),
				makeTransition('b', 'c'),
				makeTransition('c', 'a'),
			];
			const result = autoLayout(steps, transitions, 'a');
			expect(result.size).toBe(3);
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
			expect(result.size).toBe(2);
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
			expect(result.size).toBe(4);

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
			// No node is reachable — both are orphans, still get positions
			expect(result.size).toBe(2);
		});

		it('transitions referencing unknown step IDs are ignored', () => {
			const steps = ['a', 'b'].map(makeStep);
			const transitions = [makeTransition('a', 'b'), makeTransition('a', 'zzz')];
			expect(() => autoLayout(steps, transitions, 'a')).not.toThrow();
			const result = autoLayout(steps, transitions, 'a');
			expect(result.size).toBe(2);
		});

		it('returns correct positions for a two-step linear workflow', () => {
			const steps = [makeStep('start'), makeStep('end')];
			const transitions = [makeTransition('start', 'end')];
			const result = autoLayout(steps, transitions, 'start');
			expect(result.size).toBe(2);
			expect(result.get('start')!.y).toBeLessThan(result.get('end')!.y);
		});
	});
});
