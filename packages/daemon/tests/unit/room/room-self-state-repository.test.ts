import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RoomSelfStateRepository } from '../../../src/storage/repositories/room-self-state-repository';
import type { RoomSelfWaitingContext } from '@neokai/shared';

describe('RoomSelfStateRepository waiting context', () => {
	let db: Database;
	let repo: RoomSelfStateRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE room_agent_states (
				room_id TEXT PRIMARY KEY,
				lifecycle_state TEXT NOT NULL DEFAULT 'idle',
				current_goal_id TEXT,
				current_task_id TEXT,
				active_worker_session_ids TEXT NOT NULL DEFAULT '[]',
				last_activity_at INTEGER NOT NULL,
				error_count INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				pending_actions TEXT NOT NULL DEFAULT '[]',
				waiting_context TEXT
			)
		`);

		repo = new RoomSelfStateRepository(db);
		repo.createState({ roomId: 'room-1' });
	});

	afterEach(() => {
		db.close();
	});

	it('persists and restores waiting context', () => {
		const waitingContext: RoomSelfWaitingContext = {
			type: 'escalation',
			taskId: 'task-1',
			escalationId: 'esc-1',
			reason: 'Need human approval',
			since: Date.now(),
		};

		repo.setWaitingContext('room-1', waitingContext);
		const restored = repo.getWaitingContext('room-1');

		expect(restored).toEqual(waitingContext);
	});

	it('clears waiting context', () => {
		repo.setWaitingContext('room-1', {
			type: 'review',
			taskId: 'task-1',
			reason: 'Review required',
			since: Date.now(),
		});

		repo.clearWaitingContext('room-1');

		expect(repo.getWaitingContext('room-1')).toBeNull();
	});

	it('returns null for invalid waiting_context JSON', () => {
		db.prepare(`UPDATE room_agent_states SET waiting_context = ? WHERE room_id = ?`).run(
			'{not-valid-json',
			'room-1'
		);

		expect(repo.getWaitingContext('room-1')).toBeNull();
	});
});
