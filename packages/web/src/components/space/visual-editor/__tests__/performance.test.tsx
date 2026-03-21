/**
 * Performance validation tests for the visual workflow editor with large workflows.
 *
 * This is a manual validation checkpoint, not a dedicated perf suite. Its purpose
 * is to document performance baselines and catch severe regressions in CI.
 *
 * Baselines (recorded 2026-03-20, Bun + Vitest + jsdom):
 *   - autoLayout for 25 nodes / 35 edges: < 100ms
 *   - VisualWorkflowEditor render for 25 nodes / 35 edges: < 500ms
 *
 * Topology of the large test workflow:
 *   - 25 nodes: node-0 through node-24
 *   - Linear backbone: node-0 → node-1 → … → node-24  (24 edges)
 *   - Parallel branches (11 extra edges):
 *       node-0  → node-2   (skip 1)
 *       node-0  → node-4   (skip 3)
 *       node-2  → node-5   (cross)
 *       node-4  → node-7   (cross)
 *       node-5  → node-10  (cross)
 *       node-7  → node-12  (cross)
 *       node-10 → node-15  (cross)
 *       node-12 → node-17  (cross)
 *       node-15 → node-20  (cross)
 *       node-17 → node-22  (cross)
 *       node-20 → node-24  (skip to end)
 *   Total: 24 + 11 = 35 edges
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
 * Topology (see file-level comment for details):
 *   - 24-edge linear backbone
 *   - 11 additional cross/skip edges
 */
function buildLargeWorkflow(): SpaceWorkflow {
	// 25 nodes: indices 0–24
	const steps: WorkflowStep[] = Array.from({ length: 25 }, (_, i) => makeStep(i));

	// Linear backbone: 24 edges
	const transitions: WorkflowTransition[] = [];
	for (let i = 0; i < 24; i++) {
		transitions.push(makeTransition(i, i + 1));
	}

	// 11 additional cross edges (makes total = 35)
	const crossEdges: [number, number][] = [
		[0, 2],
		[0, 4],
		[2, 5],
		[4, 7],
		[5, 10],
		[7, 12],
		[10, 15],
		[12, 17],
		[15, 20],
		[17, 22],
		[20, 24],
	];
	for (const [from, to] of crossEdges) {
		transitions.push(makeTransition(from, to));
	}

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

beforeEach(() => {
	cleanup();
});

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

	// Verify that all 25 positions are distinct and within a reasonable canvas area.
	it('autoLayout assigns unique positions to all 25 nodes', () => {
		const workflow = buildLargeWorkflow();
		const positions = autoLayout(workflow.steps, workflow.transitions, workflow.startStepId!);

		// All nodes should have a position entry.
		expect(positions.size).toBe(25);

		// Positions must not be the exact same point (no stacking).
		const positionStrings = new Set<string>();
		for (const [, pos] of positions) {
			positionStrings.add(`${pos.x},${pos.y}`);
		}
		expect(positionStrings.size).toBe(25);
	});

	// Baseline: VisualWorkflowEditor should render 25 nodes + 35 edges in < 500ms.
	it('VisualWorkflowEditor renders 25 nodes + 35 edges without errors in < 500ms', async () => {
		const workflow = buildLargeWorkflow();

		let container!: Element;
		const start = performance.now();

		await act(async () => {
			const result = render(
				<VisualWorkflowEditor workflow={workflow} onSave={vi.fn()} onCancel={vi.fn()} />
			);
			container = result.container;
		});

		const elapsed = performance.now() - start;

		// Component must mount successfully and render the editor root.
		expect(container.querySelector('[data-testid="visual-workflow-editor"]')).toBeTruthy();

		// Performance gate: initial render must complete in under 500ms.
		expect(elapsed).toBeLessThan(500);
	});

	// Sanity: the large workflow fixture has the exact expected counts.
	it('large workflow fixture has exactly 25 nodes and 35 edges', () => {
		const workflow = buildLargeWorkflow();
		expect(workflow.steps.length).toBe(25);
		expect(workflow.transitions.length).toBe(35);
	});
});
