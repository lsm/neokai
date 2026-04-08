/**
 * Unit tests for NeoActivityLogRepository
 *
 * Covers:
 * - insert and getById round-trip
 * - list (paginated, newest first)
 * - getLatestUndoable
 * - default field values
 * - pagination with `before` cursor
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { NeoActivityLogRepository } from '../../../src/storage/repositories/neo-activity-log-repository';

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

function makeRepo(db: BunDatabase): NeoActivityLogRepository {
	return new NeoActivityLogRepository(db);
}

describe('NeoActivityLogRepository', () => {
	let db: BunDatabase;
	let repo: NeoActivityLogRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	test('list returns empty array on fresh DB', () => {
		expect(repo.list()).toEqual([]);
	});

	test('insert and getById round-trip with all fields', () => {
		const entry = repo.insert({
			id: 'log-1',
			toolName: 'create_room',
			input: JSON.stringify({ name: 'My Room' }),
			output: JSON.stringify({ roomId: 'room-abc' }),
			status: 'success',
			targetType: 'room',
			targetId: 'room-abc',
			undoable: true,
			undoData: JSON.stringify({ action: 'delete_room', roomId: 'room-abc' }),
		});

		expect(entry.id).toBe('log-1');
		expect(entry.toolName).toBe('create_room');
		expect(entry.input).toBe(JSON.stringify({ name: 'My Room' }));
		expect(entry.output).toBe(JSON.stringify({ roomId: 'room-abc' }));
		expect(entry.status).toBe('success');
		expect(entry.targetType).toBe('room');
		expect(entry.targetId).toBe('room-abc');
		expect(entry.undoable).toBe(true);
		expect(entry.undoData).toBe(JSON.stringify({ action: 'delete_room', roomId: 'room-abc' }));
		expect(typeof entry.createdAt).toBe('string');

		const fetched = repo.getById('log-1');
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe('log-1');
		expect(fetched!.toolName).toBe('create_room');
		expect(fetched!.undoable).toBe(true);
	});

	test('insert uses default values for optional fields', () => {
		const entry = repo.insert({ id: 'log-2', toolName: 'list_rooms' });

		expect(entry.input).toBeNull();
		expect(entry.output).toBeNull();
		expect(entry.status).toBe('success');
		expect(entry.error).toBeNull();
		expect(entry.targetType).toBeNull();
		expect(entry.targetId).toBeNull();
		expect(entry.undoable).toBe(false);
		expect(entry.undoData).toBeNull();
	});

	test('insert with error status', () => {
		const entry = repo.insert({
			id: 'log-3',
			toolName: 'delete_room',
			status: 'error',
			error: 'Room not found',
		});

		expect(entry.status).toBe('error');
		expect(entry.error).toBe('Room not found');
	});

	test('getById returns null for missing id', () => {
		expect(repo.getById('nonexistent')).toBeNull();
	});

	test('list returns entries newest first', async () => {
		// Insert with small delays to ensure distinct created_at values
		repo.insert({ id: 'log-a', toolName: 'tool_a' });
		// Force distinct timestamps by manipulating rows directly
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:01Z' WHERE id = 'log-a'`
		).run();
		repo.insert({ id: 'log-b', toolName: 'tool_b' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:02Z' WHERE id = 'log-b'`
		).run();
		repo.insert({ id: 'log-c', toolName: 'tool_c' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:03Z' WHERE id = 'log-c'`
		).run();

		const entries = repo.list();
		expect(entries.length).toBe(3);
		expect(entries[0].id).toBe('log-c'); // newest first
		expect(entries[1].id).toBe('log-b');
		expect(entries[2].id).toBe('log-a');
	});

	test('list respects limit', () => {
		for (let i = 1; i <= 5; i++) {
			repo.insert({ id: `log-${i}`, toolName: 'tool' });
		}
		const entries = repo.list({ limit: 3 });
		expect(entries.length).toBe(3);
	});

	test('list with before cursor returns older entries', () => {
		repo.insert({ id: 'log-1', toolName: 'tool' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:01Z' WHERE id = 'log-1'`
		).run();
		repo.insert({ id: 'log-2', toolName: 'tool' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:02Z' WHERE id = 'log-2'`
		).run();
		repo.insert({ id: 'log-3', toolName: 'tool' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:03Z' WHERE id = 'log-3'`
		).run();

		// Fetch entries before log-3 using compound cursor
		const entries = repo.list({ before: { createdAt: '2025-01-01T00:00:03Z', id: 'log-3' } });
		expect(entries.length).toBe(2);
		expect(entries[0].id).toBe('log-2');
		expect(entries[1].id).toBe('log-1');
	});

	test('list with before cursor handles same-millisecond entries via id tiebreaker', () => {
		// Two entries with identical created_at — compound cursor must not drop either
		repo.insert({ id: 'log-a', toolName: 'tool' });
		repo.insert({ id: 'log-b', toolName: 'tool' });
		const sameTs = '2025-01-01T00:00:01Z';
		db.prepare(`UPDATE neo_activity_log SET created_at = ? WHERE id IN ('log-a', 'log-b')`).run(
			sameTs
		);
		repo.insert({ id: 'log-c', toolName: 'tool' });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:02Z' WHERE id = 'log-c'`
		).run();

		// First page: all 3 entries
		const page1 = repo.list({ limit: 3 });
		expect(page1.length).toBe(3);
		expect(page1[0].id).toBe('log-c');

		// Second page: use the last entry of page1 as cursor
		const lastOnPage1 = page1[page1.length - 1];
		const page2 = repo.list({
			before: { createdAt: lastOnPage1.createdAt, id: lastOnPage1.id },
			limit: 10,
		});
		// Entries older than the last page1 entry are returned without duplication
		expect(page2.every((e) => e.id !== lastOnPage1.id)).toBe(true);
	});

	test('getLatestUndoable returns null when no undoable entries exist', () => {
		repo.insert({ id: 'log-1', toolName: 'list_rooms', undoable: false });
		expect(repo.getLatestUndoable()).toBeNull();
	});

	test('getLatestUndoable returns null on empty log', () => {
		expect(repo.getLatestUndoable()).toBeNull();
	});

	test('getLatestUndoable returns the most recent undoable entry', () => {
		repo.insert({ id: 'log-1', toolName: 'create_room', undoable: true });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:01Z' WHERE id = 'log-1'`
		).run();
		repo.insert({ id: 'log-2', toolName: 'list_rooms', undoable: false });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:02Z' WHERE id = 'log-2'`
		).run();
		repo.insert({ id: 'log-3', toolName: 'delete_goal', undoable: true });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:03Z' WHERE id = 'log-3'`
		).run();

		const latest = repo.getLatestUndoable();
		expect(latest).not.toBeNull();
		expect(latest!.id).toBe('log-3');
		expect(latest!.toolName).toBe('delete_goal');
		expect(latest!.undoable).toBe(true);
	});

	test('getLatestUndoable ignores non-undoable entries between undoable ones', () => {
		repo.insert({ id: 'log-1', toolName: 'create_room', undoable: true });
		db.prepare(
			`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:01Z' WHERE id = 'log-1'`
		).run();
		// Several non-undoable entries after
		for (let i = 2; i <= 5; i++) {
			repo.insert({ id: `log-${i}`, toolName: 'list_rooms', undoable: false });
			db.prepare(
				`UPDATE neo_activity_log SET created_at = '2025-01-01T00:00:0${i}Z' WHERE id = 'log-${i}'`
			).run();
		}

		const latest = repo.getLatestUndoable();
		expect(latest!.id).toBe('log-1');
	});
});
