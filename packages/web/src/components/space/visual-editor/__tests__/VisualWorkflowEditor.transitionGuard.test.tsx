/**
 * Focused tests for the handleCreateTransition Task Agent guard in VisualWorkflowEditor.
 *
 * Port-drag is not simulatable in JSDOM (useConnectionDrag requires real mouse events
 * across port elements), so we mock WorkflowCanvas to capture the onCreateTransition
 * callback and invoke it directly. This lets us verify the guard without UI coupling.
 *
 * Tests:
 * - Does not add edge when fromLocalId is TASK_AGENT_NODE_ID
 * - Does not add edge when toLocalId is TASK_AGENT_NODE_ID
 * - Does add edge for two regular node IDs (positive case)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';

// ---- Capture WorkflowCanvas.onCreateTransition without breaking the component ----

let capturedOnCreateTransition: ((from: string, to: string) => void) | null = null;

vi.mock('../WorkflowCanvas', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../WorkflowCanvas')>();
	const Original = mod.WorkflowCanvas;
	return {
		...mod,
		WorkflowCanvas: (props: Parameters<typeof Original>[0]) => {
			capturedOnCreateTransition = props.onCreateTransition ?? null;
			return <Original {...props} />;
		},
	};
});

// ---- Mocks for VisualWorkflowEditor dependencies ----

const mockAgents: Signal<SpaceAgent[]> = signal([]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);
const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();

vi.mock('../../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			agents: mockAgents,
			workflows: mockWorkflows,
			createWorkflow: mockCreateWorkflow,
			updateWorkflow: mockUpdateWorkflow,
		};
	},
}));

vi.mock('../../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { VisualWorkflowEditor } from '../VisualWorkflowEditor';

// ---- Helpers ----

function makeAgent(id: string, name: string): SpaceAgent {
	return { id, spaceId: 'space-1', name, role: 'coder', createdAt: 0, updatedAt: 0 };
}

function makeWorkflow(): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'My Workflow',
		description: '',
		nodes: [
			{ id: 'step-1', name: 'Plan', agentId: 'agent-1', instructions: '' },
			{ id: 'step-2', name: 'Code', agentId: 'agent-2', instructions: '' },
		],
		transitions: [],
		startNodeId: 'step-1',
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
	capturedOnCreateTransition = null;
	mockAgents.value = [makeAgent('agent-1', 'Planner'), makeAgent('agent-2', 'Coder')];
	mockWorkflows.value = [];
	mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', nodes: [], transitions: [], tags: [] });
	mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', nodes: [], transitions: [], tags: [] });
	mockCreateWorkflow.mockClear();
	mockUpdateWorkflow.mockClear();
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('VisualWorkflowEditor handleCreateTransition Task Agent guard', () => {
	it('does not add an edge when fromLocalId is TASK_AGENT_NODE_ID', () => {
		const { container } = render(
			<VisualWorkflowEditor workflow={makeWorkflow()} onSave={vi.fn()} onCancel={vi.fn()} />
		);

		// Verify the callback was captured
		expect(capturedOnCreateTransition).toBeTruthy();

		const edgesBefore = container.querySelectorAll('[data-edge-id]').length;

		// Simulate what useConnectionDrag would call if a drag from Task Agent completed
		act(() => {
			capturedOnCreateTransition!(TASK_AGENT_NODE_ID, 'step-1');
		});

		// Guard must have blocked the edge
		expect(container.querySelectorAll('[data-edge-id]').length).toBe(edgesBefore);
	});

	it('does not add an edge when toLocalId is TASK_AGENT_NODE_ID', () => {
		const { container } = render(
			<VisualWorkflowEditor workflow={makeWorkflow()} onSave={vi.fn()} onCancel={vi.fn()} />
		);

		expect(capturedOnCreateTransition).toBeTruthy();

		const edgesBefore = container.querySelectorAll('[data-edge-id]').length;

		act(() => {
			capturedOnCreateTransition!('step-1', TASK_AGENT_NODE_ID);
		});

		expect(container.querySelectorAll('[data-edge-id]').length).toBe(edgesBefore);
	});

	it('does add an edge for two regular node IDs (positive case)', () => {
		const { container } = render(
			<VisualWorkflowEditor workflow={makeWorkflow()} onSave={vi.fn()} onCancel={vi.fn()} />
		);

		expect(capturedOnCreateTransition).toBeTruthy();

		// makeWorkflow has no transitions, so edges start at 0
		expect(container.querySelectorAll('[data-edge-id]').length).toBe(0);

		act(() => {
			capturedOnCreateTransition!('step-1', 'step-2');
		});

		// A real edge should be created
		expect(container.querySelectorAll('[data-edge-id]').length).toBe(1);
	});
});
