/**
 * RoomManager Tests
 *
 * Tests for room lifecycle and operations:
 * - Create rooms with auto-generated context
 * - Get room details
 * - Update rooms
 * - Archive rooms
 * - Assign/unassign sessions to rooms
 * - Get room status and global status
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/database';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { CreateRoomParams } from '@neokai/shared';

describe('RoomManager', () => {
	let db: Database;
	let roomManager: RoomManager;

	beforeEach(async () => {
		// Create in-memory database
		db = new Database(':memory:');
		await db.initialize();
		roomManager = new RoomManager(db.getDatabase());
	});

	afterEach(() => {
		db.close();
	});

	describe('createRoom', () => {
		it('should create a room with required fields only', () => {
			const params: CreateRoomParams = {
				name: 'Test Room',
			};

			const room = roomManager.createRoom(params);

			expect(room).toBeDefined();
			expect(room.id).toBeDefined();
			expect(room.name).toBe('Test Room');
			expect(room.status).toBe('active');
			expect(room.sessionIds).toEqual([]);
			expect(room.allowedPaths).toEqual([]);
			expect(room.createdAt).toBeGreaterThan(0);
			expect(room.updatedAt).toBe(room.createdAt);
		});

		it('should create a room with all optional fields', () => {
			const params: CreateRoomParams = {
				name: 'Full Room',
				description: 'A room with all fields',
				allowedPaths: ['/workspace/project1', '/workspace/project2'],
				defaultPath: '/workspace/project1',
				defaultModel: 'claude-sonnet-4-20250514',
			};

			const room = roomManager.createRoom(params);

			expect(room.name).toBe('Full Room');
			expect(room.description).toBe('A room with all fields');
			expect(room.allowedPaths).toEqual(['/workspace/project1', '/workspace/project2']);
			expect(room.defaultPath).toBe('/workspace/project1');
			expect(room.defaultModel).toBe('claude-sonnet-4-20250514');
		});

		it('should create a context for the room', () => {
			const room = roomManager.createRoom({ name: 'Context Test Room' });

			expect(room.contextId).toBeDefined();
			expect(typeof room.contextId).toBe('string');
			expect(room.contextId.length).toBeGreaterThan(0);
		});

		it('should create room atomically - context is linked in transaction', () => {
			const room = roomManager.createRoom({ name: 'Atomic Room' });

			// Room should have a valid contextId immediately after creation
			expect(room.contextId).toBeDefined();

			// Fetch room again to verify persistence
			const fetchedRoom = roomManager.getRoom(room.id);
			expect(fetchedRoom?.contextId).toBe(room.contextId);
		});

		it('should generate unique IDs for each room', () => {
			const room1 = roomManager.createRoom({ name: 'Room 1' });
			const room2 = roomManager.createRoom({ name: 'Room 2' });

			expect(room1.id).not.toBe(room2.id);
			expect(room1.contextId).not.toBe(room2.contextId);
		});

		it('should set timestamps correctly', () => {
			const before = Date.now();
			const room = roomManager.createRoom({ name: 'Timestamp Room' });
			const after = Date.now();

			expect(room.createdAt).toBeGreaterThanOrEqual(before);
			expect(room.createdAt).toBeLessThanOrEqual(after);
			expect(room.updatedAt).toBe(room.createdAt);
		});
	});

	describe('getRoom', () => {
		it('should return room by ID', () => {
			const created = roomManager.createRoom({ name: 'Get Test Room' });
			const room = roomManager.getRoom(created.id);

			expect(room).toBeDefined();
			expect(room?.id).toBe(created.id);
			expect(room?.name).toBe('Get Test Room');
		});

		it('should return null for non-existent room', () => {
			const room = roomManager.getRoom('non-existent-id');

			expect(room).toBeNull();
		});

		it('should return complete room data', () => {
			const params: CreateRoomParams = {
				name: 'Complete Room',
				description: 'Description',
				allowedPaths: ['/path1'],
				defaultPath: '/path1',
				defaultModel: 'claude-opus-4-5-20250514',
			};
			const created = roomManager.createRoom(params);
			const room = roomManager.getRoom(created.id)!;

			expect(room.name).toBe('Complete Room');
			expect(room.description).toBe('Description');
			expect(room.allowedPaths).toEqual(['/path1']);
			expect(room.defaultPath).toBe('/path1');
			expect(room.defaultModel).toBe('claude-opus-4-5-20250514');
			expect(room.status).toBe('active');
			expect(room.sessionIds).toEqual([]);
			expect(room.contextId).toBeDefined();
		});
	});

	describe('getRoomOverview', () => {
		it('should return room overview with empty sessions and tasks', () => {
			const room = roomManager.createRoom({ name: 'Overview Room' });
			const overview = roomManager.getRoomOverview(room.id);

			expect(overview).toBeDefined();
			expect(overview?.room.id).toBe(room.id);
			expect(overview?.room.name).toBe('Overview Room');
			expect(overview?.sessions).toEqual([]);
			expect(overview?.activeTasks).toEqual([]);
			expect(overview?.contextStatus).toBe('idle');
		});

		it('should return null for non-existent room', () => {
			const overview = roomManager.getRoomOverview('non-existent-id');

			expect(overview).toBeNull();
		});

		it('should include session summaries for assigned sessions', () => {
			const room = roomManager.createRoom({ name: 'Room With Sessions' });
			const dbRaw = db.getDatabase();

			// Create sessions in the database first
			// Note: In-memory databases use base schema without migration-added columns
			const now = new Date().toISOString();
			dbRaw
				.prepare(
					`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('session-1', 'Test Session 1', '/workspace', now, now, 'active', '{}', '{}');
			dbRaw
				.prepare(
					`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('session-2', 'Test Session 2', '/workspace', now, now, 'paused', '{}', '{}');

			roomManager.assignSession(room.id, 'session-1');
			roomManager.assignSession(room.id, 'session-2');

			const overview = roomManager.getRoomOverview(room.id);

			expect(overview?.sessions).toHaveLength(2);
			expect(overview?.sessions[0].id).toBe('session-1');
			expect(overview?.sessions[0].status).toBe('active');
			expect(overview?.sessions[0].title).toBe('Test Session 1');
			expect(overview?.sessions[1].id).toBe('session-2');
			expect(overview?.sessions[1].status).toBe('paused');
			expect(overview?.sessions[1].title).toBe('Test Session 2');
		});

		it('should return ended status for non-existent sessions', () => {
			const room = roomManager.createRoom({ name: 'Room With Missing Sessions' });
			// Assign sessions that don't exist in the database
			roomManager.assignSession(room.id, 'non-existent-session');

			const overview = roomManager.getRoomOverview(room.id);

			expect(overview?.sessions).toHaveLength(1);
			expect(overview?.sessions[0].id).toBe('non-existent-session');
			expect(overview?.sessions[0].status).toBe('ended');
			// Title is generated from first 8 chars of ID
			expect(overview?.sessions[0].title).toBe('Session non-exis');
		});

		it('should include active tasks in overview', () => {
			const room = roomManager.createRoom({ name: 'Room With Tasks' });
			const dbRaw = db.getDatabase();

			// Create some tasks directly in the database
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'task-1',
					room.id,
					'Active Task',
					'Description',
					'in_progress',
					'high',
					'[]',
					Date.now()
				);
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'task-2',
					room.id,
					'Completed Task',
					'Description',
					'completed',
					'normal',
					'[]',
					Date.now()
				);

			const overview = roomManager.getRoomOverview(room.id);

			// Only non-completed, non-failed tasks should be included
			expect(overview?.activeTasks).toHaveLength(1);
			expect(overview?.activeTasks[0].id).toBe('task-1');
			expect(overview?.activeTasks[0].title).toBe('Active Task');
			expect(overview?.activeTasks[0].status).toBe('in_progress');
			expect(overview?.activeTasks[0].priority).toBe('high');
		});

		it('should include context status in overview', () => {
			const room = roomManager.createRoom({ name: 'Room With Context' });
			const dbRaw = db.getDatabase();

			// Update context status
			dbRaw.prepare(`UPDATE contexts SET status = ? WHERE id = ?`).run('thinking', room.contextId);

			const overview = roomManager.getRoomOverview(room.id);

			expect(overview?.contextStatus).toBe('thinking');
		});
	});

	describe('updateRoom', () => {
		it('should update room name', () => {
			const room = roomManager.createRoom({ name: 'Original Name' });
			const updated = roomManager.updateRoom(room.id, { name: 'New Name' });

			expect(updated?.name).toBe('New Name');
			expect(updated?.id).toBe(room.id);
		});

		it('should update room description', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.updateRoom(room.id, { description: 'New description' });

			expect(updated?.description).toBe('New description');
		});

		it('should update allowed paths', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.updateRoom(room.id, {
				allowedPaths: ['/new/path1', '/new/path2'],
			});

			expect(updated?.allowedPaths).toEqual(['/new/path1', '/new/path2']);
		});

		it('should update default path', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.updateRoom(room.id, { defaultPath: '/default/path' });

			expect(updated?.defaultPath).toBe('/default/path');
		});

		it('should update default model', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.updateRoom(room.id, {
				defaultModel: 'claude-opus-4-5-20250514',
			});

			expect(updated?.defaultModel).toBe('claude-opus-4-5-20250514');
		});

		it('should update multiple fields at once', () => {
			const room = roomManager.createRoom({ name: 'Original' });
			const updated = roomManager.updateRoom(room.id, {
				name: 'Updated Name',
				description: 'Updated description',
				defaultModel: 'claude-sonnet-4-20250514',
			});

			expect(updated?.name).toBe('Updated Name');
			expect(updated?.description).toBe('Updated description');
			expect(updated?.defaultModel).toBe('claude-sonnet-4-20250514');
		});

		it('should update updatedAt timestamp', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;

			// Small delay to ensure timestamp difference
			const updated = roomManager.updateRoom(room.id, { name: 'New Name' });

			expect(updated?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
		});

		it('should return null for non-existent room', () => {
			const updated = roomManager.updateRoom('non-existent', { name: 'New Name' });

			expect(updated).toBeNull();
		});

		it('should allow clearing optional fields with null', () => {
			const room = roomManager.createRoom({
				name: 'Room',
				description: 'To be cleared',
				defaultPath: '/to/be/cleared',
				defaultModel: 'to-be-cleared',
			});

			const updated = roomManager.updateRoom(room.id, {
				description: null,
				defaultPath: null,
				defaultModel: null,
			});

			expect(updated?.description).toBeUndefined();
			expect(updated?.defaultPath).toBeUndefined();
			expect(updated?.defaultModel).toBeUndefined();
		});
	});

	describe('archiveRoom', () => {
		it('should archive an active room', () => {
			const room = roomManager.createRoom({ name: 'To Archive' });
			const archived = roomManager.archiveRoom(room.id);

			expect(archived?.status).toBe('archived');
			expect(archived?.id).toBe(room.id);
		});

		it('should update updatedAt timestamp when archiving', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;
			const archived = roomManager.archiveRoom(room.id);

			expect(archived?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
		});

		it('should return null for non-existent room', () => {
			const archived = roomManager.archiveRoom('non-existent');

			expect(archived).toBeNull();
		});

		it('should be idempotent - archiving archived room', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.archiveRoom(room.id);
			const archivedAgain = roomManager.archiveRoom(room.id);

			expect(archivedAgain?.status).toBe('archived');
		});
	});

	describe('assignSession', () => {
		it('should assign a session to a room', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.assignSession(room.id, 'session-123');

			expect(updated?.sessionIds).toContain('session-123');
		});

		it('should allow assigning multiple sessions', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.assignSession(room.id, 'session-1');
			const updated = roomManager.assignSession(room.id, 'session-2');

			expect(updated?.sessionIds).toContain('session-1');
			expect(updated?.sessionIds).toContain('session-2');
			expect(updated?.sessionIds).toHaveLength(2);
		});

		it('should be idempotent - assigning same session twice', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.assignSession(room.id, 'session-1');
			const updated = roomManager.assignSession(room.id, 'session-1');

			expect(updated?.sessionIds).toHaveLength(1);
			expect(updated?.sessionIds).toContain('session-1');
		});

		it('should return null for non-existent room', () => {
			const result = roomManager.assignSession('non-existent', 'session-1');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const originalUpdatedAt = room.updatedAt;
			const updated = roomManager.assignSession(room.id, 'session-1');

			expect(updated?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
		});
	});

	describe('unassignSession', () => {
		it('should unassign a session from a room', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.assignSession(room.id, 'session-1');
			roomManager.assignSession(room.id, 'session-2');

			const updated = roomManager.unassignSession(room.id, 'session-1');

			expect(updated?.sessionIds).not.toContain('session-1');
			expect(updated?.sessionIds).toContain('session-2');
		});

		it('should be idempotent - unassigning non-existent session', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.assignSession(room.id, 'session-1');

			const updated = roomManager.unassignSession(room.id, 'non-existent-session');

			expect(updated?.sessionIds).toHaveLength(1);
			expect(updated?.sessionIds).toContain('session-1');
		});

		it('should return null for non-existent room', () => {
			const result = roomManager.unassignSession('non-existent', 'session-1');

			expect(result).toBeNull();
		});
	});

	describe('getRoomStatus', () => {
		it('should return status for a room', () => {
			const room = roomManager.createRoom({ name: 'Status Room' });
			const status = roomManager.getRoomStatus(room.id);

			expect(status).toBeDefined();
			expect(status?.roomId).toBe(room.id);
			expect(status?.contextStatus).toBe('idle');
			expect(status?.activeTaskCount).toBe(0);
			expect(status?.memoryCount).toBe(0);
		});

		it('should return null for non-existent room', () => {
			const status = roomManager.getRoomStatus('non-existent');

			expect(status).toBeNull();
		});

		it('should count active tasks correctly', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const dbRaw = db.getDatabase();

			// Create tasks with different statuses
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-1', room.id, 'Pending', 'Desc', 'pending', 'normal', '[]', Date.now());
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-2', room.id, 'In Progress', 'Desc', 'in_progress', 'normal', '[]', Date.now());
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-3', room.id, 'Completed', 'Desc', 'completed', 'normal', '[]', Date.now());
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-4', room.id, 'Failed', 'Desc', 'failed', 'normal', '[]', Date.now());

			const status = roomManager.getRoomStatus(room.id);

			// Only pending and in_progress are "active" (not completed/failed)
			expect(status?.activeTaskCount).toBe(2);
		});

		it('should count memories correctly', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const dbRaw = db.getDatabase();

			// Create memories
			dbRaw
				.prepare(
					`INSERT INTO memories (id, room_id, type, content, tags, importance, created_at, last_accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'mem-1',
					room.id,
					'conversation',
					'Content 1',
					'[]',
					'normal',
					Date.now(),
					Date.now(),
					0
				);
			dbRaw
				.prepare(
					`INSERT INTO memories (id, room_id, type, content, tags, importance, created_at, last_accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('mem-2', room.id, 'note', 'Content 2', '[]', 'high', Date.now(), Date.now(), 0);

			const status = roomManager.getRoomStatus(room.id);

			expect(status?.memoryCount).toBe(2);
		});

		it('should include current task and session from context', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const dbRaw = db.getDatabase();

			// Update context with current task/session
			dbRaw
				.prepare(
					`UPDATE contexts SET current_task_id = ?, current_session_id = ?, status = ? WHERE id = ?`
				)
				.run('task-active', 'session-active', 'thinking', room.contextId);

			const status = roomManager.getRoomStatus(room.id);

			expect(status?.currentTaskId).toBe('task-active');
			expect(status?.currentSessionId).toBe('session-active');
			expect(status?.contextStatus).toBe('thinking');
		});

		it('should return idle status when context has no status', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const dbRaw = db.getDatabase();

			// Remove contextId from room
			dbRaw.prepare(`UPDATE rooms SET context_id = NULL WHERE id = ?`).run(room.id);

			const status = roomManager.getRoomStatus(room.id);

			expect(status?.contextStatus).toBe('idle');
		});
	});

	describe('getGlobalStatus', () => {
		it('should return empty status when no rooms exist', () => {
			const status = roomManager.getGlobalStatus();

			expect(status.rooms).toEqual([]);
			expect(status.totalActiveTasks).toBe(0);
			expect(status.totalMemories).toBe(0);
		});

		it('should aggregate status from multiple rooms', () => {
			const room1 = roomManager.createRoom({ name: 'Room 1' });
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const dbRaw = db.getDatabase();

			// Add tasks to room1
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-1', room1.id, 'Task 1', 'Desc', 'pending', 'normal', '[]', Date.now());
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-2', room1.id, 'Task 2', 'Desc', 'in_progress', 'normal', '[]', Date.now());

			// Add task to room2
			dbRaw
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('task-3', room2.id, 'Task 3', 'Desc', 'pending', 'normal', '[]', Date.now());

			// Add memories
			dbRaw
				.prepare(
					`INSERT INTO memories (id, room_id, type, content, tags, importance, created_at, last_accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'mem-1',
					room1.id,
					'conversation',
					'Content',
					'[]',
					'normal',
					Date.now(),
					Date.now(),
					0
				);
			dbRaw
				.prepare(
					`INSERT INTO memories (id, room_id, type, content, tags, importance, created_at, last_accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('mem-2', room2.id, 'note', 'Content', '[]', 'normal', Date.now(), Date.now(), 0);
			dbRaw
				.prepare(
					`INSERT INTO memories (id, room_id, type, content, tags, importance, created_at, last_accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run('mem-3', room2.id, 'note', 'Content', '[]', 'normal', Date.now(), Date.now(), 0);

			const status = roomManager.getGlobalStatus();

			expect(status.rooms).toHaveLength(2);
			expect(status.totalActiveTasks).toBe(3); // 2 from room1 + 1 from room2
			expect(status.totalMemories).toBe(3); // 1 from room1 + 2 from room2
		});

		it('should exclude archived rooms from global status', () => {
			const room1 = roomManager.createRoom({ name: 'Active Room' });
			const room2 = roomManager.createRoom({ name: 'Archived Room' });
			roomManager.archiveRoom(room2.id);

			const status = roomManager.getGlobalStatus();

			expect(status.rooms).toHaveLength(1);
			expect(status.rooms[0].roomId).toBe(room1.id);
		});

		it('should include all room status fields', () => {
			const room = roomManager.createRoom({ name: 'Room' });

			const status = roomManager.getGlobalStatus();

			expect(status.rooms[0]).toEqual({
				roomId: room.id,
				contextStatus: 'idle',
				currentTaskId: undefined,
				currentSessionId: undefined,
				activeTaskCount: 0,
				memoryCount: 0,
			});
		});
	});

	describe('listRooms', () => {
		it('should list active rooms by default', () => {
			roomManager.createRoom({ name: 'Room 1' });
			roomManager.createRoom({ name: 'Room 2' });
			const room3 = roomManager.createRoom({ name: 'Room 3' });
			roomManager.archiveRoom(room3.id);

			const rooms = roomManager.listRooms();

			expect(rooms).toHaveLength(2);
			expect(rooms.map((r) => r.name)).toEqual(expect.arrayContaining(['Room 1', 'Room 2']));
		});

		it('should include archived rooms when requested', () => {
			roomManager.createRoom({ name: 'Room 1' });
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			roomManager.archiveRoom(room2.id);

			const rooms = roomManager.listRooms(true);

			expect(rooms).toHaveLength(2);
		});

		it('should return rooms ordered by updatedAt DESC', () => {
			// Create rooms with a small delay to ensure different timestamps
			const first = roomManager.createRoom({ name: 'First Room' });
			const firstCreatedAt = first.createdAt;

			// Update the first room to ensure its updatedAt is definitely newer
			// than any room created at roughly the same time
			const updated = roomManager.updateRoom(first.id, { name: 'Updated First' });

			// Verify the update happened
			expect(updated?.updatedAt).toBeGreaterThanOrEqual(firstCreatedAt);

			// Create second room after update
			const second = roomManager.createRoom({ name: 'Second Room' });

			// Update first room again to make it newest
			roomManager.updateRoom(first.id, { name: 'Updated First Again' });

			const rooms = roomManager.listRooms();

			// First room should be first due to most recent update
			expect(rooms[0].id).toBe(first.id);
			expect(rooms[1].id).toBe(second.id);
		});
	});

	describe('addAllowedPath', () => {
		it('should add a path to allowed paths', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			const updated = roomManager.addAllowedPath(room.id, '/new/path');

			expect(updated?.allowedPaths).toContain('/new/path');
		});

		it('should be idempotent - adding same path twice', () => {
			const room = roomManager.createRoom({ name: 'Room' });
			roomManager.addAllowedPath(room.id, '/path');
			const updated = roomManager.addAllowedPath(room.id, '/path');

			expect(updated?.allowedPaths).toHaveLength(1);
		});

		it('should return null for non-existent room', () => {
			const result = roomManager.addAllowedPath('non-existent', '/path');

			expect(result).toBeNull();
		});
	});

	describe('removeAllowedPath', () => {
		it('should remove a path from allowed paths', () => {
			const room = roomManager.createRoom({
				name: 'Room',
				allowedPaths: ['/path1', '/path2'],
			});
			const updated = roomManager.removeAllowedPath(room.id, '/path1');

			expect(updated?.allowedPaths).toEqual(['/path2']);
		});

		it('should be idempotent - removing non-existent path', () => {
			const room = roomManager.createRoom({
				name: 'Room',
				allowedPaths: ['/path1'],
			});
			const updated = roomManager.removeAllowedPath(room.id, '/non-existent');

			expect(updated?.allowedPaths).toEqual(['/path1']);
		});

		it('should return null for non-existent room', () => {
			const result = roomManager.removeAllowedPath('non-existent', '/path');

			expect(result).toBeNull();
		});
	});

	describe('deleteRoom', () => {
		it('should delete a room', () => {
			const room = roomManager.createRoom({ name: 'To Delete' });
			roomManager.deleteRoom(room.id);

			const fetched = roomManager.getRoom(room.id);
			expect(fetched).toBeNull();
		});

		it('should not throw when deleting non-existent room', () => {
			expect(() => roomManager.deleteRoom('non-existent')).not.toThrow();
		});
	});
});
