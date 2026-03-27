/**
 * RoomSkillOverrideRepository Unit Tests
 *
 * Covers getOverrides, upsertOverride, deleteOverride, deleteAllForRoom,
 * notifyChange calls, cascade deletes, and per-room isolation.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { RoomSkillOverrideRepository } from '../../../src/storage/repositories/room-skill-override-repository';
import { SkillRepository } from '../../../src/storage/repositories/skill-repository';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';
import type { AppSkill } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('RoomSkillOverrideRepository', () => {
	let bunDb: BunDatabase;
	let reactiveDb: ReactiveDatabase;
	let repo: RoomSkillOverrideRepository;
	let skillRepo: SkillRepository;
	let notifyChangeSpy: ReturnType<typeof mock>;

	const ROOM_A = 'room-aaa';
	const ROOM_B = 'room-bbb';

	function insertRoom(id: string): void {
		const now = Date.now();
		bunDb
			.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run(id, id, now, now);
	}

	function insertSkill(name: string, enabled = true): string {
		const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const skill: AppSkill = {
			id,
			name,
			displayName: name,
			description: `${name} skill`,
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: name },
			enabled,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: Date.now(),
		};
		skillRepo.insert(skill);
		return id;
	}

	beforeEach(() => {
		bunDb = new BunDatabase(':memory:');
		bunDb.exec('PRAGMA foreign_keys = ON');
		createTables(bunDb);

		reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
		notifyChangeSpy = mock(() => {});
		reactiveDb.notifyChange = notifyChangeSpy;

		skillRepo = new SkillRepository(bunDb, reactiveDb);
		repo = new RoomSkillOverrideRepository(bunDb, reactiveDb);

		insertRoom(ROOM_A);
		insertRoom(ROOM_B);
	});

	afterEach(() => {
		bunDb.close();
	});

	// ---------------------------------------------------------------------------
	// getOverrides
	// ---------------------------------------------------------------------------

	describe('getOverrides', () => {
		test('returns empty array when no overrides exist', () => {
			expect(repo.getOverrides(ROOM_A)).toEqual([]);
		});

		test('returns all overrides for a room', () => {
			const skillId1 = insertSkill('alpha');
			const skillId2 = insertSkill('beta');
			repo.upsertOverride(ROOM_A, skillId1, true);
			repo.upsertOverride(ROOM_A, skillId2, false);

			const overrides = repo.getOverrides(ROOM_A);
			expect(overrides).toHaveLength(2);
			expect(overrides).toContainEqual({ skillId: skillId1, roomId: ROOM_A, enabled: true });
			expect(overrides).toContainEqual({ skillId: skillId2, roomId: ROOM_A, enabled: false });
		});

		test('per-room isolation — ROOM_A overrides do not appear in ROOM_B', () => {
			const skillId = insertSkill('isolated');
			repo.upsertOverride(ROOM_A, skillId, true);

			expect(repo.getOverrides(ROOM_A)).toHaveLength(1);
			expect(repo.getOverrides(ROOM_B)).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// upsertOverride
	// ---------------------------------------------------------------------------

	describe('upsertOverride', () => {
		test('inserts an enabled override', () => {
			const skillId = insertSkill('enabled-skill');
			repo.upsertOverride(ROOM_A, skillId, true);

			const overrides = repo.getOverrides(ROOM_A);
			expect(overrides).toEqual([{ skillId, roomId: ROOM_A, enabled: true }]);
		});

		test('inserts a disabled override', () => {
			const skillId = insertSkill('disabled-skill');
			repo.upsertOverride(ROOM_A, skillId, false);

			const overrides = repo.getOverrides(ROOM_A);
			expect(overrides).toEqual([{ skillId, roomId: ROOM_A, enabled: false }]);
		});

		test('upserts — flipping from disabled to enabled', () => {
			const skillId = insertSkill('flipper');
			repo.upsertOverride(ROOM_A, skillId, false);
			repo.upsertOverride(ROOM_A, skillId, true);

			const overrides = repo.getOverrides(ROOM_A);
			expect(overrides).toEqual([{ skillId, roomId: ROOM_A, enabled: true }]);
		});

		test('calls notifyChange after each write', () => {
			const skillId = insertSkill('notifier');
			notifyChangeSpy.mockClear();
			repo.upsertOverride(ROOM_A, skillId, true);

			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('room_skill_overrides');
		});
	});

	// ---------------------------------------------------------------------------
	// deleteOverride
	// ---------------------------------------------------------------------------

	describe('deleteOverride', () => {
		test('removes a single override', () => {
			const skillId = insertSkill('removable');
			repo.upsertOverride(ROOM_A, skillId, true);
			expect(repo.getOverrides(ROOM_A)).toHaveLength(1);

			repo.deleteOverride(ROOM_A, skillId);
			expect(repo.getOverrides(ROOM_A)).toHaveLength(0);
		});

		test('does not affect other overrides in the same room', () => {
			const skillId1 = insertSkill('keep');
			const skillId2 = insertSkill('remove');
			repo.upsertOverride(ROOM_A, skillId1, true);
			repo.upsertOverride(ROOM_A, skillId2, true);

			repo.deleteOverride(ROOM_A, skillId2);
			const overrides = repo.getOverrides(ROOM_A);
			expect(overrides).toHaveLength(1);
			expect(overrides[0].skillId).toBe(skillId1);
		});

		test('calls notifyChange after delete', () => {
			const skillId = insertSkill('delete-notify');
			repo.upsertOverride(ROOM_A, skillId, true);
			notifyChangeSpy.mockClear();

			repo.deleteOverride(ROOM_A, skillId);
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('room_skill_overrides');
		});

		test('no-op when override does not exist', () => {
			const skillId = insertSkill('nonexistent');
			expect(() => repo.deleteOverride(ROOM_A, skillId)).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// deleteAllForRoom
	// ---------------------------------------------------------------------------

	describe('deleteAllForRoom', () => {
		test('removes all overrides for a room', () => {
			const skillId1 = insertSkill('all-1');
			const skillId2 = insertSkill('all-2');
			repo.upsertOverride(ROOM_A, skillId1, true);
			repo.upsertOverride(ROOM_A, skillId2, false);

			repo.deleteAllForRoom(ROOM_A);
			expect(repo.getOverrides(ROOM_A)).toEqual([]);
		});

		test('does not affect other rooms', () => {
			const skillId = insertSkill('cross-room-delete');
			repo.upsertOverride(ROOM_A, skillId, true);
			repo.upsertOverride(ROOM_B, skillId, false);

			repo.deleteAllForRoom(ROOM_A);
			expect(repo.getOverrides(ROOM_A)).toEqual([]);
			expect(repo.getOverrides(ROOM_B)).toHaveLength(1);
		});

		test('calls notifyChange after delete', () => {
			const skillId = insertSkill('all-notify');
			repo.upsertOverride(ROOM_A, skillId, true);
			notifyChangeSpy.mockClear();

			repo.deleteAllForRoom(ROOM_A);
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('room_skill_overrides');
		});

		test('no-op when room has no overrides', () => {
			expect(() => repo.deleteAllForRoom('nonexistent-room')).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// Cascade deletes
	// ---------------------------------------------------------------------------

	describe('cascade deletes', () => {
		test('deleting a room removes its overrides (ON DELETE CASCADE)', () => {
			const skillId = insertSkill('cascade-room');
			repo.upsertOverride(ROOM_A, skillId, true);

			bunDb.prepare(`DELETE FROM rooms WHERE id = ?`).run(ROOM_A);
			expect(repo.getOverrides(ROOM_A)).toEqual([]);
		});

		test('deleting a skill removes its overrides (ON DELETE CASCADE)', () => {
			const skillId = insertSkill('cascade-skill');
			repo.upsertOverride(ROOM_A, skillId, true);
			repo.upsertOverride(ROOM_B, skillId, false);

			// Delete the skill row directly (FK cascade should clean up overrides)
			bunDb.prepare(`DELETE FROM skills WHERE id = ?`).run(skillId);
			expect(repo.getOverrides(ROOM_A)).toEqual([]);
			expect(repo.getOverrides(ROOM_B)).toEqual([]);
		});
	});
});
