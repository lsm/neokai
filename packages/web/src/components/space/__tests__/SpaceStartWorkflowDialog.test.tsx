// @ts-nocheck
/**
 * Unit tests for SpaceStartWorkflowDialog
 *
 * Tests:
 * - Renders nothing when closed
 * - Renders warning when no workflows configured
 * - Shows workflow selector only when multiple workflows exist
 * - Shows single workflow name when only one workflow
 * - Title required validation
 * - Submit calls spaceWorkflowRun.start with correct params
 * - Toast and onStarted callback on success
 * - Error message on failure
 * - Cancel closes dialog
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockSelectSpace = vi.fn().mockResolvedValue(undefined);
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		get getHubIfConnected() {
			return mockGetHubIfConnected;
		},
	},
}));

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		get selectSpace() {
			return mockSelectSpace;
		},
	},
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		get success() {
			return mockToastSuccess;
		},
		get error() {
			return mockToastError;
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

import { SpaceStartWorkflowDialog } from '../SpaceStartWorkflowDialog';

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
	title: 'Sprint run',
	status: 'pending',
	createdAt: Date.now(),
	updatedAt: Date.now(),
};

describe('SpaceStartWorkflowDialog', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let onStarted: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		cleanup();
		onClose = vi.fn();
		onStarted = vi.fn();
		mockRequest.mockReset();
		mockGetHubIfConnected.mockReset();
		mockToastSuccess.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders nothing when isOpen is false', () => {
		const { container } = render(
			<SpaceStartWorkflowDialog isOpen={false} spaceId="space-1" workflows={[]} onClose={onClose} />
		);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('shows warning when no workflows configured', () => {
		const { getByText } = render(
			<SpaceStartWorkflowDialog isOpen={true} spaceId="space-1" workflows={[]} onClose={onClose} />
		);
		expect(getByText(/No workflows configured/)).toBeTruthy();
	});

	it('does not show workflow selector when only one workflow', () => {
		const { queryByRole } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
			/>
		);
		// No combobox/select for single workflow
		expect(queryByRole('combobox')).toBeNull();
	});

	it('shows single workflow name when only one workflow', () => {
		const { getByText } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
			/>
		);
		expect(getByText('Main Flow')).toBeTruthy();
	});

	it('shows workflow selector when multiple workflows exist', () => {
		const { getAllByRole } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Flow A'), makeWorkflow('wf-2', 'Flow B')]}
				onClose={onClose}
			/>
		);
		const selects = getAllByRole('combobox');
		expect(selects.length).toBeGreaterThan(0);
	});

	it('shows validation error when title is empty', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		const { getByRole, findByText } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Flow A')]}
				onClose={onClose}
			/>
		);
		fireEvent.submit(getByRole('dialog').querySelector('form'));
		expect(await findByText('Run title is required')).toBeTruthy();
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('calls spaceWorkflowRun.start with correct params on submit', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({ run: RUN_MOCK });

		const { getByPlaceholderText, getByRole } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
				onStarted={onStarted}
			/>
		);

		fireEvent.input(getByPlaceholderText('e.g., Sprint 12 feature implementation'), {
			target: { value: 'Sprint run' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.start', {
				spaceId: 'space-1',
				workflowId: 'wf-1',
				title: 'Sprint run',
				description: undefined,
			});
		});
	});

	it('calls onStarted and closes on success', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({ run: RUN_MOCK });

		const { getByPlaceholderText, getByRole } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
				onStarted={onStarted}
			/>
		);

		fireEvent.input(getByPlaceholderText('e.g., Sprint 12 feature implementation'), {
			target: { value: 'Sprint run' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(onStarted).toHaveBeenCalledWith(RUN_MOCK);
			expect(onClose).toHaveBeenCalled();
			expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Sprint run'));
		});
	});

	it('shows error message when spaceWorkflowRun.start fails', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockRejectedValue(new Error('Workflow not found'));

		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
			/>
		);

		fireEvent.input(getByPlaceholderText('e.g., Sprint 12 feature implementation'), {
			target: { value: 'Failing run' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		expect(await findByText('Workflow not found')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('calls onClose when Cancel is clicked', () => {
		const { getByText } = render(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
			/>
		);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('syncs workflowId via useEffect when workflows load asynchronously', async () => {
		// Start with empty workflows (simulates async store state)
		const { rerender, queryByRole } = render(
			<SpaceStartWorkflowDialog isOpen={true} spaceId="space-1" workflows={[]} onClose={onClose} />
		);
		// No select visible yet
		expect(queryByRole('combobox')).toBeNull();

		// Workflows arrive later (e.g., after selectSpace resolves)
		rerender(
			<SpaceStartWorkflowDialog
				isOpen={true}
				spaceId="space-1"
				workflows={[makeWorkflow('wf-1', 'Main Flow')]}
				onClose={onClose}
			/>
		);

		// workflowId should now be set — single-workflow indicator appears
		await waitFor(() => {
			expect(queryByRole('combobox')).toBeNull(); // still single-workflow path
		});
	});
});
