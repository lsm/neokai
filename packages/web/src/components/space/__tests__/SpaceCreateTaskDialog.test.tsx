// @ts-nocheck
/**
 * Unit tests for SpaceCreateTaskDialog
 *
 * Tests:
 * - Dialog renders when open / hidden when closed
 * - Title required validation
 * - Submit calls spaceStore.createTask with correct params
 * - Shows toast and calls onCreated on success
 * - Shows error message on failure
 * - Cancel closes and resets form
 * - Priority and type selectors update form state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockCreateTask = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		get createTask() {
			return mockCreateTask;
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
	status: 'open',
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
		mockCreateTask.mockReset();
		mockToastSuccess.mockReset();
		mockToastError.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders nothing when isOpen is false', () => {
		const { container } = render(<SpaceCreateTaskDialog isOpen={false} onClose={onClose} />);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('renders dialog when isOpen is true', () => {
		const { getByRole } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
		expect(getByRole('dialog')).toBeTruthy();
	});

	it('shows title required indicator', () => {
		const { getByText } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
		expect(getByText('Title')).toBeTruthy();
		expect(getByText('*')).toBeTruthy();
	});

	it('shows validation error when title is empty', async () => {
		const { getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
		);
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form);
		expect(await findByText('Task title is required')).toBeTruthy();
		expect(mockCreateTask).not.toHaveBeenCalled();
	});

	it('calls spaceStore.createTask with correct params on submit', async () => {
		mockCreateTask.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} onCreated={onCreated} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'My new task' },
		});

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockCreateTask).toHaveBeenCalledWith({
				title: 'My new task',
				description: '',
				priority: 'normal',
				taskType: 'coding',
			});
		});
	});

	it('calls onCreated and closes on success', async () => {
		mockCreateTask.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} onCreated={onCreated} />
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

	it('shows error message when createTask fails', async () => {
		mockCreateTask.mockRejectedValue(new Error('Server error'));

		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'Failing task' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		expect(await findByText('Server error')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('shows error when no space is selected (createTask throws)', async () => {
		mockCreateTask.mockRejectedValue(new Error('No space selected'));

		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'My task' },
		});
		fireEvent.submit(getByRole('dialog').querySelector('form'));

		expect(await findByText('No space selected')).toBeTruthy();
	});

	it('calls onClose when Cancel is clicked', () => {
		const { getByText } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('sends correct priority when changed', async () => {
		mockCreateTask.mockResolvedValue(TASK_MOCK);

		const { getByPlaceholderText, getByRole, getAllByRole } = render(
			<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
		);

		fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
			target: { value: 'Urgent task' },
		});

		const selects = getAllByRole('combobox');
		fireEvent.change(selects[0], { target: { value: 'urgent' } });

		fireEvent.submit(getByRole('dialog').querySelector('form'));

		await waitFor(() => {
			expect(mockCreateTask).toHaveBeenCalledWith(
				expect.objectContaining({
					priority: 'urgent',
				})
			);
		});
	});
});
