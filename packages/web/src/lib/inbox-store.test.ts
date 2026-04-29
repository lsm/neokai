/**
 * Tests for InboxStore
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskSummary } from '@neokai/shared/types/neo';
import type { InboxTask } from './inbox-store.ts';

const { mockGetHub, mockToastError } = vi.hoisted(() => ({
	mockGetHub: vi.fn(),
	mockToastError: vi.fn(),
}));

vi.mock('./connection-manager', () => ({ connectionManager: { getHub: mockGetHub } }));
vi.mock('./toast', () => ({ toast: { error: mockToastError } }));

const { inboxStore } = await import('./inbox-store.ts');

function makeTask(id: string, status: TaskSummary['status'], updatedAt = Date.now()): TaskSummary {
	return {
		id,
		title: `Task ${id}`,
		status,
		priority: 'normal',
		progress: null,
		dependsOn: [],
		updatedAt,
	};
}

function makeInboxTask(task: TaskSummary, roomId: string, roomTitle: string): InboxTask {
	return { task, roomId, roomTitle };
}

describe('InboxStore', () => {
	beforeEach(() => {
		inboxStore.items.value = [];
		inboxStore.isLoading.value = false;
		vi.clearAllMocks();
	});

	describe('refresh()', () => {
		it('should call inbox.reviewTasks RPC and set items from response', async () => {
			const reviewTasks = [makeInboxTask(makeTask('t1', 'review', 3000), 'room-a', 'Room A')];
			const mockHub = { request: vi.fn().mockResolvedValue({ tasks: reviewTasks }) };
			mockGetHub.mockResolvedValue(mockHub);
			await inboxStore.refresh();
			expect(mockHub.request).toHaveBeenCalledWith('inbox.reviewTasks', {});
			expect(inboxStore.items.value).toEqual(reviewTasks);
		});

		it('should set items to empty array on error', async () => {
			const mockHub = { request: vi.fn().mockRejectedValue(new Error('Connection lost')) };
			mockGetHub.mockResolvedValue(mockHub);
			await inboxStore.refresh();
			expect(inboxStore.items.value).toEqual([]);
		});

		it('should set isLoading to false after completion', async () => {
			const mockHub = { request: vi.fn().mockResolvedValue({ tasks: [] }) };
			mockGetHub.mockResolvedValue(mockHub);
			const p = inboxStore.refresh();
			expect(inboxStore.isLoading.value).toBe(true);
			await p;
			expect(inboxStore.isLoading.value).toBe(false);
		});

		it('should set isLoading to false even on error', async () => {
			const mockHub = { request: vi.fn().mockRejectedValue(new Error('fail')) };
			mockGetHub.mockResolvedValue(mockHub);
			await inboxStore.refresh();
			expect(inboxStore.isLoading.value).toBe(false);
		});
	});

	describe('approveTask()', () => {
		it('should call task.approve, refresh, and return true', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockImplementationOnce(() => Promise.resolve(undefined))
					.mockImplementationOnce(() => Promise.resolve({ tasks: [] })),
			};
			mockGetHub.mockResolvedValue(mockHub);
			expect(await inboxStore.approveTask('t1', 'r')).toBe(true);
			expect(mockHub.request).toHaveBeenCalledWith('inbox.reviewTasks', {});
		});

		it('should show toast.error and return false when approveTask fails', async () => {
			const mockHub = { request: vi.fn().mockRejectedValueOnce(new Error('Network error')) };
			mockGetHub.mockResolvedValue(mockHub);
			const result = await inboxStore.approveTask('task-1', 'room-1');
			expect(result).toBe(false);
			expect(mockToastError).toHaveBeenCalledWith('Network error');
		});
	});

	describe('rejectTask()', () => {
		it('should call task.reject with feedback, refresh, and return true', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockImplementationOnce(() => Promise.resolve(undefined))
					.mockImplementationOnce(() => Promise.resolve({ tasks: [] })),
			};
			mockGetHub.mockResolvedValue(mockHub);
			expect(await inboxStore.rejectTask('t1', 'r', 'feedback')).toBe(true);
			expect(mockHub.request).toHaveBeenCalledWith('inbox.reviewTasks', {});
		});

		it('should show toast.error and return false when rejectTask fails', async () => {
			const mockHub = { request: vi.fn().mockRejectedValueOnce(new Error('Network error')) };
			mockGetHub.mockResolvedValue(mockHub);
			const result = await inboxStore.rejectTask('task-1', 'room-1', 'needs work');
			expect(result).toBe(false);
			expect(mockToastError).toHaveBeenCalledWith('Network error');
		});
	});

	describe('reviewCount', () => {
		it('should return 0 when empty', () => {
			inboxStore.items.value = [];
			expect(inboxStore.reviewCount.value).toBe(0);
		});
		it('should return count', () => {
			inboxStore.items.value = [makeInboxTask(makeTask('t1', 'review'), 'r', 'R')];
			expect(inboxStore.reviewCount.value).toBe(1);
		});
	});
});
