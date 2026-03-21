/**
 * Performance validation tests for the visual workflow editor with large workflows.
 *
 * This is a manual validation checkpoint, not a dedicated perf suite. Its purpose
 * is to document performance baselines and catch severe regressions in CI.
 *
 * Baselines (recorded 2026-03-20, Bun + Vitest + jsdom):
 *   - autoLayout for 25 nodes / 35 edges: < 100ms  (typical: ~3ms)
 *   - VisualWorkflowEditor fully settled for 25 nodes / 35 edges: < 500ms
 *     (typical: ~65-70ms; "fully settled" means act() has flushed all effects,
 *      state updates and microtasks triggered by useMemo / useState initializers)
 *
 * Topology of the large test workflow — genuine fan-out / fan-in DAG:
 *
 *   Layer 0 (1 node):   n0
 *   Layer 1 (5 nodes):  n1, n2, n3, n4, n5         ← fan-out from n0
 *   Layer 2 (5 nodes):  n6, n7, n8, n9, n10        ← fan-out from layer 1
 *   Layer 3 (5 nodes):  n11, n12, n13, n14, n15    ← fan-out from layer 2
 *   Layer 4 (5 nodes):  n16, n17, n18, n19, n20    ← fan-out from layer 3
 *   Layer 5 (4 nodes):  n21, n22, n23, n24         ← converge
 *
 * Multiple nodes share every interior layer, so the horizontal-separation logic
 * inside autoLayout is meaningfully exercised (unlike a purely linear chain where
 * every node would land in its own unique layer).
 *
 * Edge count breakdown:
 *   Main fan-out chains:              5 + 5 + 5 + 5 + 5 = 25 edges
 *   Cross-layer forward edges:        2 + 3 + 3 + 2     = 10 edges
 *   Total:                                                 35 edges
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow, WorkflowStep, WorkflowTransition } from '@neokai/shared';

// ---- Mocks ----

const mockAgents: Signal<SpaceAgent[]> = signal([
	{
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Test Agent',
		role: 'coder',
		createdAt: 0,
		updatedAt: 0,
	},
]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);

vi.mock('../../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			agents: mockAgents,
			workflows: mockWorkflows,
			createWorkflow: vi.fn(),
			updateWorkflow: vi.fn(),
		};
	},
}));

vi.mock('../../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { autoLayout } from '../layout';
import { VisualWorkflowEditor } from '../VisualWorkflowEditor';

// ============================================================================
// Helpers
// ============================================================================

/** Create a WorkflowStep with a given index. */
function makeStep(index: number): WorkflowStep {
	return { id: `node-${index}`, name: `Step ${index}`, agentId: 'agent-1' };
}

/** Create a WorkflowTransition between two step indices. */
function makeTransition(from: number, to: number): WorkflowTransition {
	return { id: `tr-${from}-${to}`, from: `node-${from}`, to: `node-${to}`, order: 0 };
}

/**
 * Build a large workflow with 25 nodes and 35 edges.
 *
 * The topology uses genuine fan-out layers so that multiple nodes share the same
 * y-coordinate and the horizontal-separation logic inside autoLayout is exercised.
 * See the file-level comment for the full layer breakdown and edge-count proof.
 */
function buildLargeWorkflow(): SpaceWorkflow {
	// 25 nodes: n0 through n24
	const steps: WorkflowStep[] = Array.from({ length: 25 }, (_, i) => makeStep(i));

	// Main fan-out chains (25 edges):
	//   n0 → n1…n5 (layer 0 → layer 1)
	//   n1→n6, n2→n7, n3→n8, n4→n9, n5→n10 (layer 1 → layer 2)
	//   n6→n11, n7→n12, n8→n13, n9→n14, n10→n15 (layer 2 → layer 3)
	//   n11→n16, n12→n17, n13→n18, n14→n19, n15→n20 (layer 3 → layer 4)
	//   n16→n21, n17→n21, n18→n22, n19→n23, n20→n24 (layer 4 → layer 5)
	const mainEdges: [number, number][] = [
		[0, 1],
		[0, 2],
		[0, 3],
		[0, 4],
		[0, 5],
		[1, 6],
		[2, 7],
		[3, 8],
		[4, 9],
		[5, 10],
		[6, 11],
		[7, 12],
		[8, 13],
		[9, 14],
		[10, 15],
		[11, 16],
		[12, 17],
		[13, 18],
		[14, 19],
		[15, 20],
		[16, 21],
		[17, 21],
		[18, 22],
		[19, 23],
		[20, 24],
	];

	// Cross-layer forward edges (10 edges):
	//   These add additional arcs between parallel branches within the same
	//   fan-out level; all target nodes already have a longer incoming path,
	//   so their layer assignments are unchanged (verified by tracing the
	//   longest-path algorithm in layout.ts).
	const crossEdges: [number, number][] = [
		[1, 7],
		[2, 8], // layer 1 → layer 2
		[6, 12],
		[7, 13],
		[8, 14], // layer 2 → layer 3
		[11, 17],
		[12, 18],
		[13, 19], // layer 3 → layer 4
		[16, 22],
		[17, 23], // layer 4 → layer 5
	];

	const transitions: WorkflowTransition[] = [...mainEdges, ...crossEdges].map(([f, t]) =>
		makeTransition(f, t)
	);

	return {
		id: 'large-wf',
		spaceId: 'space-1',
		name: 'Large Workflow',
		description: 'Performance test workflow with 25 nodes and 35 edges',
		steps,
		transitions,
		startStepId: 'node-0',
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('VisualWorkflowEditor performance — large workflow (25 nodes, 35 edges)', () => {
	// Baseline: autoLayout for 25 nodes / 35 edges should complete in < 100ms.
	it('autoLayout for 25 nodes completes in < 100ms', () => {
		const workflow = buildLargeWorkflow();

		const start = performance.now();
		const positions = autoLayout(workflow.steps, workflow.transitions, workflow.startStepId!);
		const elapsed = performance.now() - start;

		// Verify correctness: all 25 nodes must receive a position.
		expect(positions.size).toBe(25);

		// Performance gate: layout must finish well within 100ms.
		// This guards against accidental O(n²) or O(n³) regressions.
		expect(elapsed).toBeLessThan(100);
	});

	// Verify that all 25 positions are distinct — exercises the horizontal-separation
	// logic inside autoLayout since layers 1–5 each contain multiple nodes that must
	// be assigned different x-coordinates.
	it('autoLayout assigns unique positions to all 25 nodes', () => {
		const workflow = buildLargeWorkflow();
		const positions = autoLayout(workflow.steps, workflow.transitions, workflow.startStepId!);

		// All nodes should have a position entry.
		expect(positions.size).toBe(25);

		// No two nodes may share the exact same canvas point.
		const positionStrings = new Set<string>();
		for (const [, pos] of positions) {
			positionStrings.add(`${pos.x},${pos.y}`);
		}
		expect(positionStrings.size).toBe(25);
	});

	// Baseline: VisualWorkflowEditor should be fully settled for 25 nodes + 35 edges
	// within 500ms. "Fully settled" means act() has flushed all pending effects, state
	// updates, and microtasks (useMemo/useState initialisers, signal subscriptions,
	// post-render async work). This is broader than raw DOM-paint time but is the
	// meaningful threshold for interactive readiness.
	it('VisualWorkflowEditor renders 25 nodes + 35 edges without errors in < 500ms', async () => {
		const workflow = buildLargeWorkflow();

		let container: Element | null = null;
		const start = performance.now();

		await act(async () => {
			const result = render(
				<VisualWorkflowEditor workflow={workflow} onSave={vi.fn()} onCancel={vi.fn()} />
			);
			container = result.container;
		});

		const elapsed = performance.now() - start;

		// Component must mount successfully and render the editor root.
		expect(container).not.toBeNull();
		expect(container!.querySelector('[data-testid="visual-workflow-editor"]')).toBeTruthy();

		// Performance gate: fully settled in under 500ms.
		expect(elapsed).toBeLessThan(500);
	});

	// Sanity: the large workflow fixture has the exact expected counts.
	it('large workflow fixture has exactly 25 nodes and 35 edges', () => {
		const workflow = buildLargeWorkflow();
		expect(workflow.steps.length).toBe(25);
		expect(workflow.transitions.length).toBe(35);
	});
});
