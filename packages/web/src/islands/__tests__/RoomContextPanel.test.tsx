// @ts-nocheck
/**
 * UI-level tests for RoomContextPanel
 *
 * Specifically guards against the regression where the "+ New Session" button
 * passed a hardcoded title to roomStore.createSession(), which permanently
 * disabled auto-title generation for the session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';

// -------------------------------------------------------
// Hoisted mocks
// -------------------------------------------------------

const { mockCreateSession, mockNavigateToRoomSession, mockNavigateToRooms, mockNavigateToRoom } =
	vi.hoisted(() => ({
		mockCreateSession: vi.fn().mockResolvedValue('new-session-id'),
		mockNavigateToRoomSession: vi.fn(),
		mockNavigateToRooms: vi.fn(),
		mockNavigateToRoom: vi.fn(),
	}));

// -------------------------------------------------------
// Signals used in mocks
// -------------------------------------------------------

let mockTasksSignal: ReturnType<typeof signal<any[]>>;
let mockSessionsSignal: ReturnType<typeof signal<any[]>>;
let mockCurrentRoomSessionIdSignal: ReturnType<typeof signal<string | null>>;

vi.mock('../../lib/room-store.ts', () => ({
	get roomStore() {
		return {
			tasks: mockTasksSignal,
			sessions: mockSessionsSignal,
			createSession: mockCreateSession,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToRooms: mockNavigateToRooms,
	navigateToRoom: mockNavigateToRoom,
	navigateToRoomSession: mockNavigateToRoomSession,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get currentRoomSessionIdSignal() {
			return mockCurrentRoomSessionIdSignal;
		},
	};
});

// Initialize signals before importing the component
mockTasksSignal = signal([]);
mockSessionsSignal = signal([]);
mockCurrentRoomSessionIdSignal = signal(null);

import { RoomContextPanel } from '../RoomContextPanel';

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomContextPanel — New Session button', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		mockTasksSignal.value = [];
		mockSessionsSignal.value = [];
		mockCurrentRoomSessionIdSignal.value = null;
		mockCreateSession.mockResolvedValue('new-session-id');
	});

	afterEach(() => {
		cleanup();
	});

	it('calls roomStore.createSession() without a title when the button is clicked', async () => {
		render(<RoomContextPanel roomId="room-1" />);

		const button = screen.getByRole('button', { name: /New Session/i });
		fireEvent.click(button);

		await vi.waitFor(() => {
			expect(mockCreateSession).toHaveBeenCalledOnce();
		});

		// Must be called with no arguments so title is undefined and the daemon
		// sets titleGenerated: false, enabling auto-title generation
		expect(mockCreateSession).toHaveBeenCalledWith();
	});

	it('navigates to the new session after creation', async () => {
		render(<RoomContextPanel roomId="room-1" />);

		const button = screen.getByRole('button', { name: /New Session/i });
		fireEvent.click(button);

		await vi.waitFor(() => {
			expect(mockNavigateToRoomSession).toHaveBeenCalledWith('room-1', 'new-session-id');
		});
	});
});
