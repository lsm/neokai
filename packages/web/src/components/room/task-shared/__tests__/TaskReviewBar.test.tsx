/**
 * Tests for TaskReviewBar component
 *
 * Verifies that the approve/reject action bar renders correctly and fires callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { NeoTask } from '@neokai/shared';
import { TaskReviewBar } from '../TaskReviewBar';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

vi.mock('../../../ui/ActionBar.tsx', () => ({
	ActionBar: ({
		primaryAction,
		secondaryAction,
	}: {
		primaryAction: { label: string; onClick: () => void; loading?: boolean };
		secondaryAction: { label: string; onClick: () => void; disabled?: boolean };
	}) => (
		<div data-testid="action-bar">
			<button
				data-testid="approve-button"
				onClick={primaryAction.onClick}
				disabled={primaryAction.loading}
			>
				{primaryAction.label}
			</button>
			<button
				data-testid="reject-button"
				onClick={secondaryAction.onClick}
				disabled={secondaryAction.disabled}
			>
				{secondaryAction.label}
			</button>
		</div>
	),
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status: 'review',
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
// Tests
// -------------------------------------------------------

describe('TaskReviewBar', () => {
	beforeEach(() => cleanup());

	it('renders the action bar', () => {
		const { getByTestId } = render(
			<TaskReviewBar
				task={makeTask()}
				approving={false}
				rejecting={false}
				onApprove={vi.fn()}
				onOpenRejectModal={vi.fn()}
				reviewError={null}
			/>
		);
		expect(getByTestId('action-bar')).not.toBeNull();
	});

	it('calls onApprove when approve button clicked', () => {
		const onApprove = vi.fn();
		const { getByTestId } = render(
			<TaskReviewBar
				task={makeTask()}
				approving={false}
				rejecting={false}
				onApprove={onApprove}
				onOpenRejectModal={vi.fn()}
				reviewError={null}
			/>
		);
		fireEvent.click(getByTestId('approve-button'));
		expect(onApprove).toHaveBeenCalled();
	});

	it('calls onOpenRejectModal when reject button clicked', () => {
		const onOpenRejectModal = vi.fn();
		const { getByTestId } = render(
			<TaskReviewBar
				task={makeTask()}
				approving={false}
				rejecting={false}
				onApprove={vi.fn()}
				onOpenRejectModal={onOpenRejectModal}
				reviewError={null}
			/>
		);
		fireEvent.click(getByTestId('reject-button'));
		expect(onOpenRejectModal).toHaveBeenCalled();
	});

	it('shows reviewError when provided', () => {
		const { container } = render(
			<TaskReviewBar
				task={makeTask()}
				approving={false}
				rejecting={false}
				onApprove={vi.fn()}
				onOpenRejectModal={vi.fn()}
				reviewError="Something went wrong"
			/>
		);
		expect(container.textContent).toContain('Something went wrong');
	});

	it('does not show error section when reviewError is null', () => {
		const { container } = render(
			<TaskReviewBar
				task={makeTask()}
				approving={false}
				rejecting={false}
				onApprove={vi.fn()}
				onOpenRejectModal={vi.fn()}
				reviewError={null}
			/>
		);
		expect(container.textContent).not.toContain('Something went wrong');
	});
});
