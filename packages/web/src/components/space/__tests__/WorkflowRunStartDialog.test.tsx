// @ts-nocheck
/**
 * Unit tests for WorkflowRunStartDialog
 *
 * Tests:
 * - Renders nothing when dialog is closed
 * - Shows empty state with "Go to Workflows" button when no workflows configured
 * - Calls onSwitchToWorkflows and closes when "Go to Workflows" is clicked
 * - Shows single workflow name (no select) when only one workflow
 * - Shows workflow dropdown when multiple workflows exist
 * - Title is optional — auto-generated when left blank
 * - Submit calls spaceStore.startWorkflowRun with correct params
 * - Shows success toast and calls onStarted on success
 * - Shows error message on failure
 * - Cancel closes the dialog
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';

const mockStartWorkflowRun = vi.fn();
const mockWorkflowsSignal = signal([]);
const mockToastSuccess = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		get workflows() {
			return mockWorkflowsSignal;
		},
		get startWorkflowRun() {
			return mockStartWorkflowRun;
		},
	},
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		get success() {
			return mockToastSuccess;
		},
	},
}));

vi.mock('../../ui/Modal', () => ({
	Modal: ({ isOpen, children, title, onClose }) => {
		if (!isOpen) return null;
		return (
			<div role="dialog" aria-label={title}>
				<button onClick={onClose} aria-label="Close modal">
					X
				</button>
				{children}
			</div>
		);
	},
}));

vi.mock('../../ui/Button', () => ({
	Button: ({ children, onClick, type, loading, disabled }) => (
		<button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
			{loading ? 'Loading...' : children}
		</button>
	),
}));

import { WorkflowRunStartDialog } from '../WorkflowRunStartDialog';

function makeWorkflow(id: string, name: string) {
	return {
		id,
		spaceId: 'space-1',
		name,
		description: '',
		nodes: [],
		gates: [],
		rules: [],
		channels: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

const RUN_MOCK = {
	id: 'run-1',
	spaceId: 'space-1',
	workflowId: 'wf-1',
	title: 'My Flow — 2024-01-15 10:30',
	status: 'pending',
	createdAt: Date.now(),
	updatedAt: Date.now(),
};

describe('WorkflowRunStartDialog', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let onStarted: ReturnType<typeof vi.fn>;
	let onSwitchToWorkflows: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		cleanup();
		onClose = vi.fn();
		onStarted = vi.fn();
		onSwitchToWorkflows = vi.fn();
		mockStartWorkflowRun.mockReset();
		mockToastSuccess.mockReset();
		mockWorkflowsSignal.value = [];
	});

	afterEach(() => {
		cleanup();
	});

	it('renders nothing when isOpen is false', () => {
		const { container } = render(<WorkflowRunStartDialog isOpen={false} onClose={onClose} />);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('shows empty state when no workflows configured', () => {
		mockWorkflowsSignal.value = [];
		const { getByText } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		expect(getByText(/No workflows available/)).toBeTruthy();
	});

	it('shows "Go to Workflows tab" button in empty state when onSwitchToWorkflows provided', () => {
		mockWorkflowsSignal.value = [];
		const { getByText } = render(
			<WorkflowRunStartDialog
				isOpen={true}
				onClose={onClose}
				onSwitchToWorkflows={onSwitchToWorkflows}
			/>
		);
		expect(getByText('Go to Workflows tab')).toBeTruthy();
	});

	it('calls onSwitchToWorkflows and closes when "Go to Workflows tab" clicked', () => {
		mockWorkflowsSignal.value = [];
		const { getByText } = render(
			<WorkflowRunStartDialog
				isOpen={true}
				onClose={onClose}
				onSwitchToWorkflows={onSwitchToWorkflows}
			/>
		);
		fireEvent.click(getByText('Go to Workflows tab'));
		expect(onClose).toHaveBeenCalled();
		expect(onSwitchToWorkflows).toHaveBeenCalled();
	});

	it('does not show workflow select when only one workflow', () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		const { queryByRole } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		expect(queryByRole('combobox')).toBeNull();
	});

	it('shows single workflow name when only one workflow', () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		const { getByText } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		expect(getByText('Main Flow')).toBeTruthy();
	});

	it('shows workflow dropdown when multiple workflows exist', () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Flow A'), makeWorkflow('wf-2', 'Flow B')];
		const { getAllByRole } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		expect(getAllByRole('combobox').length).toBeGreaterThan(0);
	});

	it('auto-generates title when title field is left blank', async () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		mockStartWorkflowRun.mockResolvedValue(RUN_MOCK);

		const { getByRole } = render(
			<WorkflowRunStartDialog isOpen={true} onClose={onClose} onStarted={onStarted} />
		);

		// Submit without filling in a title
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockStartWorkflowRun).toHaveBeenCalledWith(
				expect.objectContaining({
					workflowId: 'wf-1',
					title: expect.stringContaining('Main Flow'),
				})
			);
		});
	});

	it('uses provided title when filled in', async () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		mockStartWorkflowRun.mockResolvedValue(RUN_MOCK);

		const { getByRole, getByPlaceholderText } = render(
			<WorkflowRunStartDialog isOpen={true} onClose={onClose} onStarted={onStarted} />
		);

		// The placeholder reflects the auto-suggested title
		const input = getByRole('dialog').querySelector('input[type="text"]');
		fireEvent.input(input, { target: { value: 'Custom title' } });
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockStartWorkflowRun).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Custom title' })
			);
		});
	});

	it('calls onStarted and closes on success', async () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		mockStartWorkflowRun.mockResolvedValue(RUN_MOCK);

		const { getByRole } = render(
			<WorkflowRunStartDialog isOpen={true} onClose={onClose} onStarted={onStarted} />
		);

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(onStarted).toHaveBeenCalledWith(RUN_MOCK);
			expect(onClose).toHaveBeenCalled();
			expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining(RUN_MOCK.title));
		});
	});

	it('shows error message when startWorkflowRun fails', async () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		mockStartWorkflowRun.mockRejectedValue(new Error('Server error'));

		const { getByRole, findByText } = render(
			<WorkflowRunStartDialog isOpen={true} onClose={onClose} />
		);

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		expect(await findByText('Server error')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('calls onClose when Cancel is clicked', () => {
		mockWorkflowsSignal.value = [makeWorkflow('wf-1', 'Main Flow')];
		const { getByText } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('disables Start Run button when no workflows available', () => {
		mockWorkflowsSignal.value = [];
		const { getByText } = render(<WorkflowRunStartDialog isOpen={true} onClose={onClose} />);
		const startBtn = getByText('Start Run');
		expect(startBtn.disabled).toBe(true);
	});
});
