// @ts-nocheck
/**
 * Unit tests for SpaceCreateTaskDialog
 *
 * Tests:
 * - Dialog renders when open / hidden when closed
 * - Title required validation
 * - Submit calls spaceTask.create RPC with correct params
 * - Shows toast and calls onCreated on success
 * - Shows error message on failure
 * - Cancel closes and resets form
 * - Priority and type selectors update form state
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

import { SpaceCreateTaskDialog } from '../SpaceCreateTaskDialog';

const TASK_MOCK = {
	id: 'task-1',
	spaceId: 'space-1',
	title: 'Test task',
	description: '',
	status: 'pending',
	priority: 'normal',
	taskType: 'coding',
	dependsOn: [],
	createdAt: Date.now(),
	updatedAt: Date.now(),
};

describe('SpaceCreateTaskDialog', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let onCreated: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		cleanup();
		onClose = vi.fn();
		onCreated = vi.fn();
		mockRequest.mockReset();
		mockGetHubIfConnected.mockReset();
		mockToastSuccess.mockReset();
		mockToastError.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders nothing when isOpen is false', () => {
		const { container } = render(
			<SpaceCreateTaskDialog isOpen={false} spaceId="space-1" onClose={onClose} />
		);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('renders dialog when isOpen is true', () => {
		const { getByRole } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);
		expect(getByRole('dialog')).toBeTruthy();
	});

	it('shows title required indicator', () => {
		const { getByText } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);
		expect(getByText('Title')).toBeTruthy();
		expect(getByText('*')).toBeTruthy();
	});

	it('shows validation error when title is empty', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		const { getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form);
		expect(await findByText('Task title is required')).toBeTruthy();
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('shows error when not connected', async () => {
		mockGetHubIfConnected.mockReturnValue(null);
		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);
		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'My task' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));
		expect(await findByText('Not connected to server')).toBeTruthy();
	});

	it('calls spaceTask.create with correct params on submit', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole } = render(
			<SpaceCreateTaskDialog
				isOpen={true}
				spaceId="space-1"
				onClose={onClose}
				onCreated={onCreated}
			/>
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'My new task' },
		});

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('spaceTask.create', {
				spaceId: 'space-1',
				title: 'My new task',
				description: '',
				priority: 'normal',
				taskType: 'coding',
			});
		});
	});

	it('calls onCreated and closes on success', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole } = render(
			<SpaceCreateTaskDialog
				isOpen={true}
				spaceId="space-1"
				onClose={onClose}
				onCreated={onCreated}
			/>
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'My task' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(onCreated).toHaveBeenCalledWith(TASK_MOCK);
			expect(onClose).toHaveBeenCalled();
			expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Test task'));
		});
	});

	it('shows error message when spaceTask.create fails', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockRejectedValue(new Error('Server error'));

		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'Failing task' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		expect(await findByText('Server error')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('calls onClose when Cancel is clicked', () => {
		const { getByText } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('sends correct priority when changed', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole, getAllByRole } = render(
			<SpaceCreateTaskDialog isOpen={true} spaceId="space-1" onClose={onClose} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'Urgent task' },
		});

		const selects = getAllByRole('combobox');
		fireEvent.change(selects[0], { target: { value: 'urgent' } });

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'spaceTask.create',
				expect.objectContaining({
					priority: 'urgent',
				})
			);
		});
	});
});
