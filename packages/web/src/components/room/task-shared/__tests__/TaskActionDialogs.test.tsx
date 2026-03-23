/**
 * Tests for TaskActionDialogs components
 *
 * Verifies that CompleteTaskDialog, CancelTaskDialog, ArchiveTaskDialog,
 * and SetStatusModal render correctly and invoke callbacks as expected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import type { NeoTask } from '@neokai/shared';
import {
	CompleteTaskDialog,
	CancelTaskDialog,
	ArchiveTaskDialog,
	SetStatusModal,
} from '../TaskActionDialogs';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

vi.mock('../../../ui/Modal.tsx', () => ({
	Modal: ({ isOpen, children, title }: { isOpen: boolean; children: unknown; title: string }) => {
		if (!isOpen) return null;
		return (
			<div data-testid="modal">
				<h2>{title}</h2>
				{children}
			</div>
		);
	},
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status: 'in_progress',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		taskType: null,
		description: null,
		dependsOn: [],
		progress: null,
		result: null,
		prUrl: null,
		prNumber: null,
		activeSession: null,
		...overrides,
	} as NeoTask;
}

// -------------------------------------------------------
// CompleteTaskDialog
// -------------------------------------------------------

describe('CompleteTaskDialog', () => {
	beforeEach(() => cleanup());

	it('does not render when isOpen is false', () => {
		const { queryByTestId } = render(
			<CompleteTaskDialog task={makeTask()} isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(queryByTestId('modal')).toBeNull();
	});

	it('renders when isOpen is true', () => {
		const { getByTestId } = render(
			<CompleteTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(getByTestId('modal')).not.toBeNull();
	});

	it('displays task title in confirmation message', () => {
		const { getByText } = render(
			<CompleteTaskDialog
				task={makeTask({ title: 'My Special Task' })}
				isOpen={true}
				onClose={vi.fn()}
				onConfirm={vi.fn()}
			/>
		);
		expect(getByText('My Special Task')).not.toBeNull();
	});

	it('calls onConfirm with summary text when confirm button clicked', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		const { getByTestId, getByPlaceholderText } = render(
			<CompleteTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} />
		);

		const textarea = getByPlaceholderText('Briefly describe what was accomplished...');
		fireEvent.input(textarea, { target: { value: 'Done!' } });

		fireEvent.click(getByTestId('complete-task-confirm'));

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith('Done!');
		});
	});

	it('calls onClose when cancel button clicked', () => {
		const onClose = vi.fn();
		const { getByText } = render(
			<CompleteTaskDialog task={makeTask()} isOpen={true} onClose={onClose} onConfirm={vi.fn()} />
		);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});
});

// -------------------------------------------------------
// CancelTaskDialog
// -------------------------------------------------------

describe('CancelTaskDialog', () => {
	beforeEach(() => cleanup());

	it('does not render when isOpen is false', () => {
		const { queryByTestId } = render(
			<CancelTaskDialog task={makeTask()} isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(queryByTestId('modal')).toBeNull();
	});

	it('renders when isOpen is true', () => {
		const { getByTestId } = render(
			<CancelTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(getByTestId('modal')).not.toBeNull();
	});

	it('calls onConfirm when cancel task button clicked', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		const { getByTestId } = render(
			<CancelTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} />
		);
		fireEvent.click(getByTestId('cancel-task-confirm'));
		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalled();
		});
	});

	it('calls onClose when keep task button clicked', () => {
		const onClose = vi.fn();
		const { getByText } = render(
			<CancelTaskDialog task={makeTask()} isOpen={true} onClose={onClose} onConfirm={vi.fn()} />
		);
		fireEvent.click(getByText('Keep Task'));
		expect(onClose).toHaveBeenCalled();
	});
});

// -------------------------------------------------------
// ArchiveTaskDialog
// -------------------------------------------------------

describe('ArchiveTaskDialog', () => {
	beforeEach(() => cleanup());

	it('does not render when isOpen is false', () => {
		const { queryByTestId } = render(
			<ArchiveTaskDialog task={makeTask()} isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(queryByTestId('modal')).toBeNull();
	});

	it('renders when isOpen is true', () => {
		const { getByTestId } = render(
			<ArchiveTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(getByTestId('modal')).not.toBeNull();
	});

	it('calls onConfirm when archive button clicked', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		const { getByTestId } = render(
			<ArchiveTaskDialog task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} />
		);
		fireEvent.click(getByTestId('archive-task-confirm'));
		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalled();
		});
	});
});

// -------------------------------------------------------
// SetStatusModal
// -------------------------------------------------------

describe('SetStatusModal', () => {
	beforeEach(() => cleanup());

	it('renders when isOpen is true', () => {
		const { getByTestId } = render(
			<SetStatusModal task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} />
		);
		expect(getByTestId('modal')).not.toBeNull();
	});

	it('calls onConfirm with selected status when confirm clicked', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		const { getByTestId } = render(
			<SetStatusModal
				task={makeTask({ status: 'in_progress' })}
				isOpen={true}
				onClose={vi.fn()}
				onConfirm={onConfirm}
			/>
		);

		const select = getByTestId('modal').querySelector('select') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'completed' } });

		fireEvent.click(getByTestId('set-status-confirm'));

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith('completed');
		});
	});

	it('does not call onConfirm if no status is selected', () => {
		const onConfirm = vi.fn();
		const { getByTestId } = render(
			<SetStatusModal task={makeTask()} isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} />
		);

		// Confirm button should be disabled without a selection
		const confirmBtn = getByTestId('set-status-confirm') as HTMLButtonElement;
		expect(confirmBtn.disabled).toBe(true);
	});
});
