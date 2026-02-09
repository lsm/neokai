/**
 * RoomManager
 *
 * Simple room membership tracking for scoped messaging.
 * Manages which clients are members of which rooms.
 */

/**
 * Room membership manager
 */
export class RoomManager {
	private rooms: Map<string, Set<string>> = new Map(); // room -> Set<clientId>
	private clientRooms: Map<string, Set<string>> = new Map(); // clientId -> Set<room>

	/**
	 * Add a client to a room
	 */
	joinRoom(clientId: string, room: string): void {
		// Add room to client's room list
		let clientRoomSet = this.clientRooms.get(clientId);
		if (!clientRoomSet) {
			clientRoomSet = new Set();
			this.clientRooms.set(clientId, clientRoomSet);
		}
		clientRoomSet.add(room);

		// Add client to room's member list
		let roomMemberSet = this.rooms.get(room);
		if (!roomMemberSet) {
			roomMemberSet = new Set();
			this.rooms.set(room, roomMemberSet);
		}
		roomMemberSet.add(clientId);
	}

	/**
	 * Remove a client from a room
	 */
	leaveRoom(clientId: string, room: string): void {
		// Remove room from client's room list
		const clientRoomSet = this.clientRooms.get(clientId);
		if (clientRoomSet) {
			clientRoomSet.delete(room);
			if (clientRoomSet.size === 0) {
				this.clientRooms.delete(clientId);
			}
		}

		// Remove client from room's member list
		const roomMemberSet = this.rooms.get(room);
		if (roomMemberSet) {
			roomMemberSet.delete(clientId);
			if (roomMemberSet.size === 0) {
				this.rooms.delete(room);
			}
		}
	}

	/**
	 * Get all members of a room
	 * Returns empty Set if room doesn't exist
	 */
	getRoomMembers(room: string): Set<string> {
		return this.rooms.get(room) || new Set();
	}

	/**
	 * Get all rooms a client is a member of
	 * Returns empty Set if client has no rooms
	 */
	getClientRooms(clientId: string): Set<string> {
		return this.clientRooms.get(clientId) || new Set();
	}

	/**
	 * Remove a client from all rooms (disconnect cleanup)
	 */
	removeClient(clientId: string): void {
		const clientRoomSet = this.clientRooms.get(clientId);
		if (clientRoomSet) {
			// Remove client from all rooms
			for (const room of clientRoomSet) {
				const roomMemberSet = this.rooms.get(room);
				if (roomMemberSet) {
					roomMemberSet.delete(clientId);
					if (roomMemberSet.size === 0) {
						this.rooms.delete(room);
					}
				}
			}
			// Remove client from tracking
			this.clientRooms.delete(clientId);
		}
	}

	/**
	 * Check if a client is a member of a room
	 */
	isInRoom(clientId: string, room: string): boolean {
		const clientRoomSet = this.clientRooms.get(clientId);
		return clientRoomSet ? clientRoomSet.has(room) : false;
	}

	/**
	 * Get total number of rooms
	 */
	getRoomCount(): number {
		return this.rooms.size;
	}

	/**
	 * Get number of clients in a room
	 */
	getClientCount(room: string): number {
		const roomMemberSet = this.rooms.get(room);
		return roomMemberSet ? roomMemberSet.size : 0;
	}
}
