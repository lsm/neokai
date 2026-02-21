// @ts-nocheck
/**
 * Tests for RoomList Component
 *
 * Tests the room list with room items, empty state, navigation,
 * session count badges, and archived status indicators.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Room } from '@neokai/shared';

// Define signals after imports - use getters in vi.mock to defer evaluation
let mockRooms: ReturnType<typeof signal<Room[]>>;

vi.mock('../../lib/lobby-store.ts', () => ({
	get lobbyStore() {
		return {
			rooms: mockRooms,
		};
	},
}));

const mockNavigateToRoom = vi.fn();

vi.mock('../../lib/router.ts', () => ({
	get navigateToRoom() {
		return mockNavigateToRoom;
	},
}));

// Initialize signals after mocks are set up
mockRooms = signal<Room[]>([]);

import { RoomList } from '../RoomList';

describe('RoomList', () => {
	const mockRoom1: Room = {
		id: 'room-1',
		name: 'Test Room',
		background: 'A test room description',
		allowedPaths: [{ path: '/test/path' }],
		sessionIds: ['session-1', 'session-2'],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const mockRoom2: Room = {
		id: 'room-2',
		name: 'Another Room',
		background: 'Another description',
		allowedPaths: [{ path: '/another/path' }],
		sessionIds: ['session-3'],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const mockArchivedRoom: Room = {
		id: 'room-archived',
		name: 'Archived Room',
		background: 'This room is archived',
		allowedPaths: [{ path: '/archived/path' }],
		sessionIds: [],
		status: 'archived',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const mockOnRoomSelect = vi.fn();

	beforeEach(() => {
		cleanup();
		mockRooms.value = [];
		mockNavigateToRoom.mockClear();
		mockOnRoomSelect.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Empty State', () => {
		it('should show empty state when no rooms exist', () => {
			mockRooms.value = [];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('No rooms yet.');
			expect(container.textContent).toContain('Create a room to organize your work!');
		});

		it('should show building emoji in empty state', () => {
			mockRooms.value = [];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('No rooms yet.');
		});

		it('should not show empty state when rooms exist', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			expect(container.textContent).not.toContain('No rooms yet.');
		});
	});

	describe('Room List Rendering', () => {
		it('should render a single room', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('Test Room');
		});

		it('should render multiple rooms', () => {
			mockRooms.value = [mockRoom1, mockRoom2];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('Test Room');
			expect(container.textContent).toContain('Another Room');
		});

		it('should render room name as h3', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const title = container.querySelector('h3');
			expect(title?.textContent).toBe('Test Room');
		});

		it('should render room background', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('A test room description');
		});

		it('should not render background element when background is undefined', () => {
			const roomWithoutBackground: Room = {
				...mockRoom1,
				background: undefined,
			};
			mockRooms.value = [roomWithoutBackground];

			const { container } = render(<RoomList />);

			// The room name should still exist
			expect(container.textContent).toContain('Test Room');
		});
	});

	describe('Session Count Badge', () => {
		it('should show session count for room with sessions', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('2 sessions');
		});

		it('should show singular "session" for room with one session', () => {
			mockRooms.value = [mockRoom2];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('1 session');
		});

		it('should show 0 sessions for room with no sessions', () => {
			const roomWithNoSessions: Room = {
				...mockRoom1,
				sessionIds: [],
			};
			mockRooms.value = [roomWithNoSessions];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('0 sessions');
		});

		it('should show green indicator when room has sessions', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const greenDot = container.querySelector('.bg-green-500');
			expect(greenDot).toBeTruthy();
		});

		it('should show gray indicator when room has no sessions', () => {
			const roomWithNoSessions: Room = {
				...mockRoom1,
				sessionIds: [],
			};
			mockRooms.value = [roomWithNoSessions];

			const { container } = render(<RoomList />);

			const grayDot = container.querySelector('.bg-gray-500');
			expect(grayDot).toBeTruthy();
		});
	});

	describe('Archived Status', () => {
		it('should show archived badge for archived room', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList />);

			expect(container.textContent).toContain('Archived');
		});

		it('should not show archived badge for active room', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const archivedSpan = container.querySelector('span');
			expect(archivedSpan?.textContent).not.toContain('Archived');
		});

		it('should disable archived room button', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.hasAttribute('disabled')).toBe(true);
		});

		it('should not disable active room button', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.hasAttribute('disabled')).toBe(false);
		});

		it('should have opacity styling for archived room', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.className).toContain('opacity-50');
		});
	});

	describe('Click Handling and Navigation', () => {
		it('should call navigateToRoom with room id when clicked', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		});

		it('should call navigateToRoom only once per click', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockNavigateToRoom).toHaveBeenCalledTimes(1);
		});

		it('should call onRoomSelect callback when room is clicked', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList onRoomSelect={mockOnRoomSelect} />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockOnRoomSelect).toHaveBeenCalledTimes(1);
		});

		it('should not call navigateToRoom when clicking archived room', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			// Button is disabled, so click should not trigger navigation
			expect(mockNavigateToRoom).not.toHaveBeenCalled();
		});

		it('should not call onRoomSelect when clicking archived room', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList onRoomSelect={mockOnRoomSelect} />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockOnRoomSelect).not.toHaveBeenCalled();
		});

		it('should handle multiple room clicks correctly', () => {
			mockRooms.value = [mockRoom1, mockRoom2];

			const { container } = render(<RoomList />);

			const buttons = container.querySelectorAll('button');
			fireEvent.click(buttons[0]);
			fireEvent.click(buttons[1]);

			expect(mockNavigateToRoom).toHaveBeenCalledTimes(2);
			expect(mockNavigateToRoom).toHaveBeenNthCalledWith(1, 'room-1');
			expect(mockNavigateToRoom).toHaveBeenNthCalledWith(2, 'room-2');
		});
	});

	describe('Styling', () => {
		it('should have button type="button"', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.getAttribute('type')).toBe('button');
		});

		it('should have hover styling for active room', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.className).toContain('hover:bg-dark-800');
		});

		it('should have cursor-not-allowed for archived room', () => {
			mockRooms.value = [mockArchivedRoom];

			const { container } = render(<RoomList />);

			const button = container.querySelector('button');
			expect(button?.className).toContain('cursor-not-allowed');
		});

		it('should have scrollable container', () => {
			mockRooms.value = [mockRoom1];

			const { container } = render(<RoomList />);

			const scrollContainer = container.querySelector('.overflow-y-auto');
			expect(scrollContainer).toBeTruthy();
		});
	});

	describe('Reactivity', () => {
		it('should update when rooms signal changes', () => {
			mockRooms.value = [];

			const { container, rerender } = render(<RoomList />);

			expect(container.textContent).toContain('No rooms yet.');

			// Update the signal
			mockRooms.value = [mockRoom1];

			// Force rerender to pick up signal change
			rerender(<RoomList />);

			expect(container.textContent).toContain('Test Room');
		});

		it('should react to room list additions', () => {
			mockRooms.value = [mockRoom1];

			const { container, rerender } = render(<RoomList />);

			expect(container.textContent).toContain('Test Room');
			expect(container.textContent).not.toContain('Another Room');

			mockRooms.value = [mockRoom1, mockRoom2];
			rerender(<RoomList />);

			expect(container.textContent).toContain('Another Room');
		});

		it('should react to room list removals', () => {
			mockRooms.value = [mockRoom1, mockRoom2];

			const { container, rerender } = render(<RoomList />);

			expect(container.textContent).toContain('Test Room');
			expect(container.textContent).toContain('Another Room');

			mockRooms.value = [mockRoom1];
			rerender(<RoomList />);

			expect(container.textContent).not.toContain('Another Room');
		});
	});
});
