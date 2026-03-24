/**
 * Unit tests for WorkflowList
 *
 * Tests:
 * - Loading state shows spinner
 * - Empty state with create CTA
 * - Renders workflow cards with name, description, step count
 * - Tag chips rendered
 * - Mini step visualization renders dots
 * - "Create Workflow" header button fires onCreateWorkflow
 * - Edit button on card fires onEditWorkflow with correct ID
 * - Delete confirmation flow (inline confirm pattern)
 * - Delete failure shows error banner
 * - Real-time updates via SpaceStore signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkflow } from '@neokai/shared';

// ---- Mocks ----
// Signals are initialized immediately so vi.mock's lazy getter can reference them safely.

const mockLoading: Signal<boolean> = signal(false);

const mockDeleteWorkflow = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			loading: mockLoading,
			deleteWorkflow: mockDeleteWorkflow,
		};
	},
}));

vi.mock('../../../lib/connection-manager.ts', () => ({
	connectionManager: { getHubIfConnected: vi.fn() },
}));
vi.mock('../../../lib/toast.ts', () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../ImportPreviewDialog.tsx', () => ({ ImportPreviewDialog: () => null }));
vi.mock('../export-import-utils.ts', () => ({
	downloadBundle: vi.fn(),
	pickImportFile: vi.fn(),
}));

import { WorkflowList } from '../WorkflowList';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	const s1 = 'step-1';
	const s2 = 'step-2';
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'My Workflow',
		description: 'Does stuff',
		nodes: [
			{ id: s1, name: 'Plan', agentId: 'a1' },
			{ id: s2, name: 'Code', agentId: 'a2' },
		],
		transitions: [{ id: 'tr-1', from: s1, to: s2, order: 0 }],
		startNodeId: s1,
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

const defaultProps = {
	spaceId: 'space-1',
	spaceName: 'Test Space',
	workflows: [] as SpaceWorkflow[],
	onCreateWorkflow: vi.fn(),
	onEditWorkflow: vi.fn(),
};

describe('WorkflowList', () => {
	beforeEach(() => {
		cleanup();
		mockLoading.value = false;
		mockDeleteWorkflow.mockResolvedValue(undefined);
		defaultProps.workflows = [];
		defaultProps.onCreateWorkflow.mockClear();
		defaultProps.onEditWorkflow.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders loading spinner when loading', () => {
		mockLoading.value = true;
		const { container } = render(<WorkflowList {...defaultProps} />);
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('renders empty state when no workflows', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('No workflows yet')).toBeTruthy();
		expect(getByText('Create your first workflow')).toBeTruthy();
	});

	it('renders Workflows heading', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText(/Workflows/)).toBeTruthy();
	});

	it('renders Create Workflow button in header', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Create Workflow')).toBeTruthy();
	});

	it('calls onCreateWorkflow when header Create button clicked', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		fireEvent.click(getByText('Create Workflow'));
		expect(defaultProps.onCreateWorkflow).toHaveBeenCalledOnce();
	});

	it('calls onCreateWorkflow when empty-state CTA clicked', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		fireEvent.click(getByText('Create your first workflow'));
		expect(defaultProps.onCreateWorkflow).toHaveBeenCalled();
	});

	it('renders workflow card with name', () => {
		const props = { ...defaultProps, workflows: [makeWorkflow({ name: 'Feature Pipeline' })] };
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('Feature Pipeline')).toBeTruthy();
	});

	it('renders workflow description', () => {
		const props = {
			...defaultProps,
			workflows: [makeWorkflow({ description: 'Runs features end-to-end' })],
		};
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('Runs features end-to-end')).toBeTruthy();
	});

	it('renders step count', () => {
		const props = { ...defaultProps, workflows: [makeWorkflow()] };
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('2 steps')).toBeTruthy();
	});

	it('renders singular "1 step"', () => {
		const s1 = 'step-1';
		const props = {
			...defaultProps,
			workflows: [
				makeWorkflow({
					nodes: [{ id: s1, name: 'Plan', agentId: 'a1' }],
					transitions: [],
					startNodeId: s1,
				}),
			],
		};
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('renders tag chips', () => {
		const props = { ...defaultProps, workflows: [makeWorkflow({ tags: ['ci', 'dev'] })] };
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('ci')).toBeTruthy();
		expect(getByText('dev')).toBeTruthy();
	});

	it('renders mini step dots (one per step)', () => {
		const props = { ...defaultProps, workflows: [makeWorkflow()] };
		const { container } = render(<WorkflowList {...props} />);
		const dots = container.querySelectorAll('.bg-blue-400, .bg-blue-500');
		expect(dots.length).toBeGreaterThanOrEqual(2);
	});

	it('calls onEditWorkflow with workflow ID when Edit clicked', () => {
		const props = { ...defaultProps, workflows: [makeWorkflow({ id: 'wf-abc' })] };
		const { getByText } = render(<WorkflowList {...props} />);
		fireEvent.click(getByText('Edit'));
		expect(defaultProps.onEditWorkflow).toHaveBeenCalledWith('wf-abc');
	});

	it('renders multiple workflows', () => {
		const props = {
			...defaultProps,
			workflows: [
				makeWorkflow({ id: 'wf-1', name: 'Alpha' }),
				makeWorkflow({ id: 'wf-2', name: 'Beta' }),
			],
		};
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('Alpha')).toBeTruthy();
		expect(getByText('Beta')).toBeTruthy();
	});

	it('handles workflow with no steps in mini viz', () => {
		const props = {
			...defaultProps,
			workflows: [makeWorkflow({ nodes: [], transitions: [], startNodeId: '' })],
		};
		const { getByText } = render(<WorkflowList {...props} />);
		expect(getByText('No steps')).toBeTruthy();
	});

	it('renders human gate connector for human condition transition', () => {
		const s1 = 'step-1';
		const s2 = 'step-2';
		const props = {
			...defaultProps,
			workflows: [
				makeWorkflow({
					nodes: [
						{ id: s1, name: 'Plan', agentId: 'a1' },
						{ id: s2, name: 'Code', agentId: 'a2' },
					],
					transitions: [
						{ id: 'tr-1', from: s1, to: s2, condition: { type: 'human' as const }, order: 0 },
					],
					startNodeId: s1,
				}),
			],
		};
		const { container } = render(<WorkflowList {...props} />);
		expect(container.querySelector('.bg-yellow-400')).toBeTruthy();
	});

	describe('delete workflow', () => {
		it('shows inline Delete? confirmation when trash icon clicked', () => {
			const props = { ...defaultProps, workflows: [makeWorkflow()] };
			const { getByText, container } = render(<WorkflowList {...props} />);
			const trashBtn = container.querySelector(
				'button[title="Delete workflow"]'
			) as HTMLButtonElement;
			expect(trashBtn).toBeTruthy();
			fireEvent.click(trashBtn);
			expect(getByText('Delete?')).toBeTruthy();
			expect(getByText('Confirm')).toBeTruthy();
			expect(getByText('Cancel')).toBeTruthy();
		});

		it('calls deleteWorkflow when Confirm clicked', async () => {
			const props = { ...defaultProps, workflows: [makeWorkflow({ id: 'wf-del' })] };
			const { getByText, container } = render(<WorkflowList {...props} />);
			const trashBtn = container.querySelector(
				'button[title="Delete workflow"]'
			) as HTMLButtonElement;
			fireEvent.click(trashBtn);
			fireEvent.click(getByText('Confirm'));
			await waitFor(() => {
				expect(mockDeleteWorkflow).toHaveBeenCalledWith('wf-del');
			});
		});

		it('hides confirmation when Cancel clicked', () => {
			const props = { ...defaultProps, workflows: [makeWorkflow()] };
			const { getByText, queryByText, container } = render(<WorkflowList {...props} />);
			const trashBtn = container.querySelector(
				'button[title="Delete workflow"]'
			) as HTMLButtonElement;
			fireEvent.click(trashBtn);
			expect(getByText('Delete?')).toBeTruthy();
			fireEvent.click(getByText('Cancel'));
			expect(queryByText('Delete?')).toBeNull();
		});

		it('shows error banner when deleteWorkflow fails', async () => {
			mockDeleteWorkflow.mockRejectedValueOnce(new Error('Delete failed'));
			const props = { ...defaultProps, workflows: [makeWorkflow()] };
			const { getByText, container } = render(<WorkflowList {...props} />);
			const trashBtn = container.querySelector(
				'button[title="Delete workflow"]'
			) as HTMLButtonElement;
			fireEvent.click(trashBtn);
			fireEvent.click(getByText('Confirm'));
			await waitFor(() => {
				expect(getByText('Delete failed')).toBeTruthy();
			});
		});
	});
});
