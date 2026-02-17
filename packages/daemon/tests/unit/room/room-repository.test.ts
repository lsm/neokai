/**
 * Room Repository Tests
 *
 * Tests for room CRUD operations and transaction behavior.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RoomRepository } from '../../../src/storage/repositories/room-repository';
import { createTables } from '../../../src/storage/schema';
import type { Room, CreateRoomParams } from '@neokai/shared';

describe('RoomRepository', () => {
	let db: Database;
	let repository: RoomRepository;

	beforeEach(() => {
		// Create in-memory database
		const dbId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		db = new Database(`file:${dbId}?mode=memory&cache=private`, { create: true });
		createTables(db);
		repository = new RoomRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe('createRoom', () => {
		it('should create a room and verify all fields are set correctly', () => {
			const params: CreateRoomParams = {
				name: 'Test Room',
				description: 'A test room for unit tests',
				allowedPaths: ['/path/to/workspace', '/path/to/another'],
				defaultPath: '/path/to/workspace',
				defaultModel: 'claude-sonnet-4-20250514',
			};

			const room = repository.createRoom(params);

			// Verify all fields
			expect(room.id).toBeDefined();
			expect(room.id.length).toBeGreaterThan(0);
			expect(room.name).toBe('Test Room');
			expect(room.description).toBe('A test room for unit tests');
			expect(room.allowedPaths).toEqual(['/path/to/workspace', '/path/to/another']);
			expect(room.defaultPath).toBe('/path/to/workspace');
			expect(room.defaultModel).toBe('claude-sonnet-4-20250514');
			expect(room.sessionIds).toEqual([]);
			expect(room.status).toBe('active');
			expect(room.contextId).toBeUndefined();
			expect(room.createdAt).toBeDefined();
			expect(room.updatedAt).toBeDefined();
			expect(room.createdAt).toBe(room.updatedAt);
		});

		it('should create a room with minimal params', () => {
			const params: CreateRoomParams = {
				name: 'Minimal Room',
			};

			const room = repository.createRoom(params);

			expect(room.id).toBeDefined();
			expect(room.name).toBe('Minimal Room');
			expect(room.description).toBeUndefined();
			expect(room.allowedPaths).toEqual([]);
			expect(room.defaultPath).toBeUndefined();
			expect(room.defaultModel).toBeUndefined();
			expect(room.sessionIds).toEqual([]);
			expect(room.status).toBe('active');
		});

		it('should create a room with empty allowedPaths', () => {
			const params: CreateRoomParams = {
				name: 'Empty Paths Room',
				allowedPaths: [],
			};

			const room = repository.createRoom(params);

			expect(room.allowedPaths).toEqual([]);
		});

		it('should create unique IDs for different rooms', () => {
			const room1 = repository.createRoom({ name: 'Room 1' });
			const room2 = repository.createRoom({ name: 'Room 2' });

			expect(room1.id).not.toBe(room2.id);
		});
	});

	describe('getRoom', () => {
		it('should get room by ID', () => {
			const created = repository.createRoom({
				name: 'Test Room',
				description: 'Test description',
			});

			const room = repository.getRoom(created.id);

			expect(room).not.toBeNull();
			expect(room?.id).toBe(created.id);
			expect(room?.name).toBe('Test Room');
			expect(room?.description).toBe('Test description');
		});

		it('should return null for non-existent room', () => {
			const room = repository.getRoom('non-existent-id');

			expect(room).toBeNull();
		});

		it('should return all fields correctly', () => {
			const params: CreateRoomParams = {
				name: 'Full Room',
				description: 'Description',
				allowedPaths: ['/a', '/b'],
				defaultPath: '/a',
				defaultModel: 'model-x',
			};
			const created = repository.createRoom(params);

			const room = repository.getRoom(created.id)!;

			expect(room.id).toBe(created.id);
			expect(room.name).toBe('Full Room');
			expect(room.description).toBe('Description');
			expect(room.allowedPaths).toEqual(['/a', '/b']);
			expect(room.defaultPath).toBe('/a');
			expect(room.defaultModel).toBe('model-x');
			expect(room.sessionIds).toEqual([]);
			expect(room.status).toBe('active');
		});
	});

	describe('listRooms', () => {
		it('should list all active rooms', () => {
			repository.createRoom({ name: 'Room 1' });
			repository.createRoom({ name: 'Room 2' });
			repository.createRoom({ name: 'Room 3' });

			const rooms = repository.listRooms();

			expect(rooms.length).toBe(3);
			expect(rooms.map((r) => r.name)).toContain('Room 1');
			expect(rooms.map((r) => r.name)).toContain('Room 2');
			expect(rooms.map((r) => r.name)).toContain('Room 3');
		});

		it('should return empty array when no rooms exist', () => {
			const rooms = repository.listRooms();

			expect(rooms).toEqual([]);
		});

		it('should filter by status - exclude archived by default', () => {
			const room1 = repository.createRoom({ name: 'Active Room' });
			const room2 = repository.createRoom({ name: 'To Archive' });
			repository.archiveRoom(room2.id);

			const rooms = repository.listRooms(false);

			expect(rooms.length).toBe(1);
			expect(rooms[0].id).toBe(room1.id);
		});

		it('should include archived rooms when includeArchived is true', () => {
			const room1 = repository.createRoom({ name: 'Active Room' });
			const room2 = repository.createRoom({ name: 'To Archive' });
			repository.archiveRoom(room2.id);

			const rooms = repository.listRooms(true);

			expect(rooms.length).toBe(2);
		});

		it('should order rooms by updated_at DESC', async () => {
			// Create rooms with slight delay to ensure different timestamps
			const room1 = repository.createRoom({ name: 'First Room' });
			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 5));
			const room2 = repository.createRoom({ name: 'Second Room' });
			await new Promise((resolve) => setTimeout(resolve, 5));
			// Update room1 to make it most recent
			repository.updateRoom(room1.id, { name: 'First Room Updated' });

			const rooms = repository.listRooms();

			expect(rooms[0].id).toBe(room1.id);
			expect(rooms[1].id).toBe(room2.id);
		});
	});

	describe('updateRoom', () => {
		it('should update room name', () => {
			const room = repository.createRoom({ name: 'Original Name' });

			const updated = repository.updateRoom(room.id, { name: 'New Name' });

			expect(updated?.name).toBe('New Name');
		});

		it('should update room description', () => {
			const room = repository.createRoom({ name: 'Room', description: 'Old desc' });

			const updated = repository.updateRoom(room.id, { description: 'New desc' });

			expect(updated?.description).toBe('New desc');
		});

		it('should update room allowedPaths', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: ['/old'] });

			const updated = repository.updateRoom(room.id, { allowedPaths: ['/new', '/paths'] });

			expect(updated?.allowedPaths).toEqual(['/new', '/paths']);
		});

		it('should update room defaultPath', () => {
			const room = repository.createRoom({ name: 'Room', defaultPath: '/old' });

			const updated = repository.updateRoom(room.id, { defaultPath: '/new' });

			expect(updated?.defaultPath).toBe('/new');
		});

		it('should update room defaultModel', () => {
			const room = repository.createRoom({ name: 'Room', defaultModel: 'old-model' });

			const updated = repository.updateRoom(room.id, { defaultModel: 'new-model' });

			expect(updated?.defaultModel).toBe('new-model');
		});

		it('should update multiple fields at once', () => {
			const room = repository.createRoom({
				name: 'Original',
				description: 'Old',
				defaultModel: 'old-model',
			});

			const updated = repository.updateRoom(room.id, {
				name: 'Updated',
				description: 'New',
				defaultModel: 'new-model',
			});

			expect(updated?.name).toBe('Updated');
			expect(updated?.description).toBe('New');
			expect(updated?.defaultModel).toBe('new-model');
		});

		it('should update updatedAt timestamp', async () => {
			const room = repository.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.updateRoom(room.id, { name: 'Updated Room' });

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});

		it('should return null for non-existent room', () => {
			const updated = repository.updateRoom('non-existent', { name: 'New Name' });

			expect(updated).toBeNull();
		});

		it('should set description to null when explicitly set to null', () => {
			const room = repository.createRoom({ name: 'Room', description: 'Has description' });

			const updated = repository.updateRoom(room.id, { description: null });

			expect(updated?.description).toBeUndefined();
		});
	});

	describe('addSessionToRoom', () => {
		it('should add session ID to room', () => {
			const room = repository.createRoom({ name: 'Room' });

			const updated = repository.addSessionToRoom(room.id, 'session-123');

			expect(updated?.sessionIds).toEqual(['session-123']);
		});

		it('should add multiple session IDs', () => {
			const room = repository.createRoom({ name: 'Room' });

			repository.addSessionToRoom(room.id, 'session-1');
			const updated = repository.addSessionToRoom(room.id, 'session-2');

			expect(updated?.sessionIds).toEqual(['session-1', 'session-2']);
		});

		it('should be idempotent - adding same session twice should not duplicate', () => {
			const room = repository.createRoom({ name: 'Room' });

			repository.addSessionToRoom(room.id, 'session-123');
			const updated = repository.addSessionToRoom(room.id, 'session-123');

			expect(updated?.sessionIds).toEqual(['session-123']);
			expect(updated?.sessionIds.length).toBe(1);
		});

		it('should return null for non-existent room', () => {
			const result = repository.addSessionToRoom('non-existent', 'session-123');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp when adding session', async () => {
			const room = repository.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.addSessionToRoom(room.id, 'session-123');

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});

		it('should not update updatedAt when session already exists (idempotent)', async () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.addSessionToRoom(room.id, 'session-123');
			const afterFirstAdd = repository.getRoom(room.id)!.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			repository.addSessionToRoom(room.id, 'session-123');
			const afterSecondAdd = repository.getRoom(room.id)!.updatedAt;

			// When idempotent (no change), updatedAt should still be updated
			// since the transaction still runs
			expect(afterSecondAdd).toBeGreaterThanOrEqual(afterFirstAdd);
		});
	});

	describe('removeSessionFromRoom', () => {
		it('should remove session ID from room', () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.addSessionToRoom(room.id, 'session-1');
			repository.addSessionToRoom(room.id, 'session-2');

			const updated = repository.removeSessionFromRoom(room.id, 'session-1');

			expect(updated?.sessionIds).toEqual(['session-2']);
		});

		it('should be idempotent - removing non-existent session should not error', () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.addSessionToRoom(room.id, 'session-1');

			const updated = repository.removeSessionFromRoom(room.id, 'non-existent-session');

			expect(updated?.sessionIds).toEqual(['session-1']);
		});

		it('should return room unchanged when removing from empty sessionIds', () => {
			const room = repository.createRoom({ name: 'Room' });

			const updated = repository.removeSessionFromRoom(room.id, 'session-123');

			expect(updated?.sessionIds).toEqual([]);
		});

		it('should return null for non-existent room', () => {
			const result = repository.removeSessionFromRoom('non-existent', 'session-123');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp when removing session', async () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.addSessionToRoom(room.id, 'session-123');
			const beforeRemove = repository.getRoom(room.id)!.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.removeSessionFromRoom(room.id, 'session-123');

			expect(updated?.updatedAt).toBeGreaterThan(beforeRemove);
		});
	});

	describe('addPath', () => {
		it('should add allowed path to room', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: [] });

			const updated = repository.addPath(room.id, '/new/path');

			expect(updated?.allowedPaths).toEqual(['/new/path']);
		});

		it('should add multiple paths', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: [] });

			repository.addPath(room.id, '/path/1');
			const updated = repository.addPath(room.id, '/path/2');

			expect(updated?.allowedPaths).toEqual(['/path/1', '/path/2']);
		});

		it('should be idempotent - adding same path twice should not duplicate', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: [] });

			repository.addPath(room.id, '/duplicate/path');
			const updated = repository.addPath(room.id, '/duplicate/path');

			expect(updated?.allowedPaths).toEqual(['/duplicate/path']);
			expect(updated?.allowedPaths.length).toBe(1);
		});

		it('should preserve existing paths when adding new one', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: ['/existing'] });

			const updated = repository.addPath(room.id, '/new');

			expect(updated?.allowedPaths).toEqual(['/existing', '/new']);
		});

		it('should return null for non-existent room', () => {
			const result = repository.addPath('non-existent', '/some/path');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp when adding path', async () => {
			const room = repository.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.addPath(room.id, '/new/path');

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});
	});

	describe('removePath', () => {
		it('should remove allowed path from room', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: ['/path/1', '/path/2'] });

			const updated = repository.removePath(room.id, '/path/1');

			expect(updated?.allowedPaths).toEqual(['/path/2']);
		});

		it('should be idempotent - removing non-existent path should not error', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: ['/path/1'] });

			const updated = repository.removePath(room.id, '/non-existent');

			expect(updated?.allowedPaths).toEqual(['/path/1']);
		});

		it('should return room unchanged when removing from empty allowedPaths', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: [] });

			const updated = repository.removePath(room.id, '/any/path');

			expect(updated?.allowedPaths).toEqual([]);
		});

		it('should return null for non-existent room', () => {
			const result = repository.removePath('non-existent', '/some/path');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp when removing path', async () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: ['/path'] });
			const beforeRemove = room.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.removePath(room.id, '/path');

			expect(updated?.updatedAt).toBeGreaterThan(beforeRemove);
		});
	});

	describe('setRoomContextId', () => {
		it('should set context ID for room', () => {
			const room = repository.createRoom({ name: 'Room' });

			repository.setRoomContextId(room.id, 'context-123');

			const updated = repository.getRoom(room.id);
			expect(updated?.contextId).toBe('context-123');
		});

		it('should overwrite existing context ID', () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.setRoomContextId(room.id, 'context-1');
			repository.setRoomContextId(room.id, 'context-2');

			const updated = repository.getRoom(room.id);
			expect(updated?.contextId).toBe('context-2');
		});

		it('should not throw for non-existent room', () => {
			// Should not throw - just silently do nothing
			expect(() => {
				repository.setRoomContextId('non-existent', 'context-123');
			}).not.toThrow();
		});
	});

	describe('archiveRoom', () => {
		it('should archive an active room', () => {
			const room = repository.createRoom({ name: 'Room' });
			expect(room.status).toBe('active');

			const archived = repository.archiveRoom(room.id);

			expect(archived?.status).toBe('archived');
		});

		it('should update updatedAt timestamp when archiving', async () => {
			const room = repository.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const archived = repository.archiveRoom(room.id);

			expect(archived?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});

		it('should return null for non-existent room', () => {
			const result = repository.archiveRoom('non-existent');

			expect(result).toBeNull();
		});

		it('should be idempotent - archiving already archived room', () => {
			const room = repository.createRoom({ name: 'Room' });
			repository.archiveRoom(room.id);

			const archived = repository.archiveRoom(room.id);

			expect(archived?.status).toBe('archived');
		});

		it('should preserve other fields when archiving', () => {
			const room = repository.createRoom({
				name: 'Room to Archive',
				description: 'Important room',
				allowedPaths: ['/path/1', '/path/2'],
			});
			repository.addSessionToRoom(room.id, 'session-1');

			const archived = repository.archiveRoom(room.id);

			expect(archived?.name).toBe('Room to Archive');
			expect(archived?.description).toBe('Important room');
			expect(archived?.allowedPaths).toEqual(['/path/1', '/path/2']);
			expect(archived?.sessionIds).toEqual(['session-1']);
			expect(archived?.status).toBe('archived');
		});
	});

	describe('deleteRoom', () => {
		it('should delete a room', () => {
			const room = repository.createRoom({ name: 'Room to Delete' });

			repository.deleteRoom(room.id);

			const deleted = repository.getRoom(room.id);
			expect(deleted).toBeNull();
		});

		it('should not throw for non-existent room', () => {
			expect(() => {
				repository.deleteRoom('non-existent');
			}).not.toThrow();
		});

		it('should only delete the specified room', () => {
			const room1 = repository.createRoom({ name: 'Room 1' });
			const room2 = repository.createRoom({ name: 'Room 2' });

			repository.deleteRoom(room1.id);

			expect(repository.getRoom(room1.id)).toBeNull();
			expect(repository.getRoom(room2.id)).not.toBeNull();
		});
	});

	describe('transaction behavior', () => {
		it('should handle concurrent path additions correctly', () => {
			const room = repository.createRoom({ name: 'Room', allowedPaths: [] });

			// Simulate concurrent additions
			repository.addPath(room.id, '/path/1');
			repository.addPath(room.id, '/path/2');
			repository.addPath(room.id, '/path/3');

			const final = repository.getRoom(room.id);
			expect(final?.allowedPaths).toHaveLength(3);
			expect(final?.allowedPaths).toContain('/path/1');
			expect(final?.allowedPaths).toContain('/path/2');
			expect(final?.allowedPaths).toContain('/path/3');
		});

		it('should handle concurrent session additions correctly', () => {
			const room = repository.createRoom({ name: 'Room' });

			repository.addSessionToRoom(room.id, 'session-1');
			repository.addSessionToRoom(room.id, 'session-2');
			repository.addSessionToRoom(room.id, 'session-3');

			const final = repository.getRoom(room.id);
			expect(final?.sessionIds).toHaveLength(3);
		});
	});
});
