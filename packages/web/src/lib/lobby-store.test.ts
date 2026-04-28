import { describe, it, expect, beforeEach } from 'vitest';
import type { Room } from '@neokai/shared';
import { lobbyStore } from './lobby-store';

function makeRoom(id: string, status: Room['status'] = 'active'): Room {
	return {
		id,
		name: id,
		status,
		sessionIds: [],
		allowedPaths: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

describe('lobbyStore local room updates', () => {
	beforeEach(() => {
		lobbyStore.cleanup();
	});

	it('removeRoom removes a room idempotently from the local list', () => {
		lobbyStore.rooms.value = [makeRoom('room-1'), makeRoom('room-2')];

		lobbyStore.removeRoom('room-1');
		lobbyStore.removeRoom('room-1');

		expect(lobbyStore.rooms.value.map((room) => room.id)).toEqual(['room-2']);
	});

	it('markRoomArchived updates a room locally', () => {
		lobbyStore.rooms.value = [makeRoom('room-1'), makeRoom('room-2')];

		lobbyStore.markRoomArchived('room-2');

		expect(lobbyStore.rooms.value.find((room) => room.id === 'room-2')?.status).toBe('archived');
		expect(lobbyStore.rooms.value.find((room) => room.id === 'room-1')?.status).toBe('active');
	});
});
