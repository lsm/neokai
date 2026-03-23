/**
 * Tests for Inbox Component
 *
 * Tests loading state, empty state, task card rendering,
 * and "Review" button navigation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { TaskSummary } from '@neokai/shared';
import type { InboxTask } from '../../lib/inbox-store.ts';

// Hoisted mocks
const { mockRefresh } = vi.hoisted(() => ({
	mockRefresh: vi.fn().mockResolvedValue(undefined),
}));

// Mock inboxStore
const mockItemsSignal = signal<InboxTask[]>([]);
const mockIsLoadingSignal = signal<boolean>(false);
const mockReviewCount = computed(() => mockItemsSignal.value.length);

vi.mock('../../lib/inbox-store.ts', () => ({
	inboxStore: {
		get items() {
			return mockItemsSignal;
		},
		get isLoading() {
			return mockIsLoadingSignal;
		},
		get reviewCount() {
			return mockReviewCount;
		},
		refresh: mockRefresh,
	},
}));

import { Inbox } from './Inbox.tsx';
import {
	currentRoomIdSignal,
	currentRoomTaskIdSignal,
	navSectionSignal,
} from '../../lib/signals.ts';

function makeTask(id: string): TaskSummary {
	return {
		id,
		title: `Task ${id}`,
		status: 'review',
		priority: 'normal',
		progress: null,
		dependsOn: [],
		updatedAt: Date.now(),
	};
}

function makeInboxTask(taskId: string, roomId: string, roomTitle: string): InboxTask {
	return {
		task: makeTask(taskId),
		roomId,
		roomTitle,
	};
}

describe('Inbox', () => {
	beforeEach(() => {
		mockItemsSignal.value = [];
		mockIsLoadingSignal.value = false;
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render the header with title', () => {
			render(<Inbox />);
			expect(screen.getByText('Inbox')).toBeTruthy();
		});

		it('should show count of awaiting review tasks', () => {
			mockItemsSignal.value = [makeInboxTask('t1', 'r1', 'Room 1')];
			const { container } = render(<Inbox />);
			expect(container.textContent).toContain('1 awaiting review');
		});

		it('should show 0 awaiting review when empty', () => {
			const { container } = render(<Inbox />);
			expect(container.textContent).toContain('0 awaiting review');
		});
	});

	describe('Loading state', () => {
		it('should show spinner when loading', () => {
			mockIsLoadingSignal.value = true;
			const { container } = render(<Inbox />);
			// Spinner has role="status" and aria-label="Loading"
			const spinner = container.querySelector('[role="status"]');
			expect(spinner).toBeTruthy();
		});

		it('should not show empty state while loading', () => {
			mockIsLoadingSignal.value = true;
			render(<Inbox />);
			expect(screen.queryByText('No tasks awaiting review')).toBeFalsy();
		});
	});

	describe('Empty state', () => {
		it('should show empty message when not loading and no items', () => {
			mockIsLoadingSignal.value = false;
			mockItemsSignal.value = [];
			render(<Inbox />);
			expect(screen.getByText('No tasks awaiting review')).toBeTruthy();
		});
	});

	describe('InboxTaskCard', () => {
		it('should render task title and room name', () => {
			mockItemsSignal.value = [makeInboxTask('t1', 'r1', 'My Room')];
			render(<Inbox />);
			expect(screen.getByText('Task t1')).toBeTruthy();
			expect(screen.getByText('My Room')).toBeTruthy();
		});

		it('should render a View button for each task', () => {
			mockItemsSignal.value = [
				makeInboxTask('t1', 'r1', 'Room 1'),
				makeInboxTask('t2', 'r2', 'Room 2'),
			];
			render(<Inbox />);
			const buttons = screen.getAllByText('View');
			expect(buttons).toHaveLength(2);
		});

		it('should have amber left border styling', () => {
			mockItemsSignal.value = [makeInboxTask('t1', 'r1', 'Room 1')];
			const { container } = render(<Inbox />);
			const card = container.querySelector('.border-l-amber-500');
			expect(card).toBeTruthy();
		});

		it('should navigate to correct room and task on View click', () => {
			mockItemsSignal.value = [makeInboxTask('task-abc', 'room-xyz', 'Test Room')];
			render(<Inbox />);

			const reviewBtn = screen.getByText('View');
			fireEvent.click(reviewBtn);

			expect(navSectionSignal.value).toBe('rooms');
			expect(currentRoomIdSignal.value).toBe('room-xyz');
			expect(currentRoomTaskIdSignal.value).toBe('task-abc');
		});
	});

	describe('Lifecycle', () => {
		it('should call inboxStore.refresh() on mount', () => {
			render(<Inbox />);
			expect(mockRefresh).toHaveBeenCalledTimes(1);
		});
	});
});
