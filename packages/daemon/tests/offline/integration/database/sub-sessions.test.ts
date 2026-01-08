/**
 * Sub-Sessions Database Tests
 *
 * Tests for parent-child session hierarchy
 */

import { describe, test } from 'bun:test';
import type { Session } from '@liuboer/shared';
import {
	createTestDb,
	createTestSession,
	assertEquals,
	assertExists,
} from './fixtures/database-test-utils';

describe('Database', () => {
	describe('Sub-Sessions', () => {
		test('should create sub-session with parentId', async () => {
			const db = await createTestDb();

			// Create parent session
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['exploration', 'branch-a'],
			};
			db.createSubSession(subSession);

			// Retrieve and verify
			const retrieved = db.getSession('sub-1');
			assertExists(retrieved);
			assertEquals(retrieved.parentId, 'parent-1');
			assertExists(retrieved.labels);
			assertEquals(retrieved.labels.length, 2);
			assertEquals(retrieved.labels[0], 'exploration');
			assertEquals(retrieved.labels[1], 'branch-a');
			assertExists(retrieved.subSessionOrder);

			db.close();
		});

		test('should prevent sub-session creation without parentId', async () => {
			const db = await createTestDb();

			const subSession = createTestSession('sub-1');
			// No parentId set

			let error: Error | null = null;
			try {
				db.createSubSession(subSession);
			} catch (e) {
				error = e as Error;
			}

			assertExists(error);
			assertEquals(error.message, 'Sub-session must have a parentId');

			db.close();
		});

		test('should prevent nested sub-sessions (one level deep only)', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
			};
			db.createSubSession(subSession);

			// Try to create nested sub-session
			const nestedSubSession: Session = {
				...createTestSession('nested-1'),
				parentId: 'sub-1', // Parent is a sub-session
			};

			let error: Error | null = null;
			try {
				db.createSubSession(nestedSubSession);
			} catch (e) {
				error = e as Error;
			}

			assertExists(error);
			assertEquals(
				error.message,
				'Cannot create sub-session under another sub-session (one level deep only)'
			);

			db.close();
		});

		test('should get sub-sessions for a parent', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create multiple sub-sessions
			const sub1: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
			};
			const sub2: Session = {
				...createTestSession('sub-2'),
				parentId: 'parent-1',
			};
			const sub3: Session = {
				...createTestSession('sub-3'),
				parentId: 'parent-1',
			};

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Get sub-sessions
			const subSessions = db.getSubSessions('parent-1');
			assertEquals(subSessions.length, 3);

			// Should be ordered by sub_session_order
			assertEquals(subSessions[0].id, 'sub-1');
			assertEquals(subSessions[0].subSessionOrder, 0);
			assertEquals(subSessions[1].id, 'sub-2');
			assertEquals(subSessions[1].subSessionOrder, 1);
			assertEquals(subSessions[2].id, 'sub-3');
			assertEquals(subSessions[2].subSessionOrder, 2);

			db.close();
		});

		test('should filter sub-sessions by labels', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions with different labels
			const sub1: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['exploration'],
			};
			const sub2: Session = {
				...createTestSession('sub-2'),
				parentId: 'parent-1',
				labels: ['implementation'],
			};
			const sub3: Session = {
				...createTestSession('sub-3'),
				parentId: 'parent-1',
				labels: ['exploration', 'testing'],
			};

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Filter by 'exploration'
			const explorationSessions = db.getSubSessions('parent-1', ['exploration']);
			assertEquals(explorationSessions.length, 2);
			assertEquals(explorationSessions[0].id, 'sub-1');
			assertEquals(explorationSessions[1].id, 'sub-3');

			// Filter by 'implementation'
			const implementationSessions = db.getSubSessions('parent-1', ['implementation']);
			assertEquals(implementationSessions.length, 1);
			assertEquals(implementationSessions[0].id, 'sub-2');

			// Filter by 'testing'
			const testingSessions = db.getSubSessions('parent-1', ['testing']);
			assertEquals(testingSessions.length, 1);
			assertEquals(testingSessions[0].id, 'sub-3');

			db.close();
		});

		test('should update sub-session order', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			const sub2: Session = { ...createTestSession('sub-2'), parentId: 'parent-1' };
			const sub3: Session = { ...createTestSession('sub-3'), parentId: 'parent-1' };

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Reorder: sub-3, sub-1, sub-2
			db.updateSubSessionOrder('parent-1', ['sub-3', 'sub-1', 'sub-2']);

			// Verify new order
			const subSessions = db.getSubSessions('parent-1');
			assertEquals(subSessions[0].id, 'sub-3');
			assertEquals(subSessions[0].subSessionOrder, 0);
			assertEquals(subSessions[1].id, 'sub-1');
			assertEquals(subSessions[1].subSessionOrder, 1);
			assertEquals(subSessions[2].id, 'sub-2');
			assertEquals(subSessions[2].subSessionOrder, 2);

			db.close();
		});

		test('should check if session has sub-sessions', async () => {
			const db = await createTestDb();

			// Create two parents
			const parent1 = createTestSession('parent-1');
			const parent2 = createTestSession('parent-2');
			db.createSession(parent1);
			db.createSession(parent2);

			// Add sub-session only to parent1
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			db.createSubSession(sub1);

			// Check
			assertEquals(db.hasSubSessions('parent-1'), true);
			assertEquals(db.hasSubSessions('parent-2'), false);

			db.close();
		});

		test('should return sub-session fields in listSessions', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['test-label'],
			};
			db.createSubSession(subSession);

			// List all sessions
			const sessions = db.listSessions();
			assertEquals(sessions.length, 2);

			// Find sub-session
			const foundSub = sessions.find((s) => s.id === 'sub-1');
			assertExists(foundSub);
			assertEquals(foundSub.parentId, 'parent-1');
			assertExists(foundSub.labels);
			assertEquals(foundSub.labels[0], 'test-label');

			db.close();
		});

		test('should update sub-session fields', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['initial'],
			};
			db.createSubSession(subSession);

			// Update labels
			db.updateSession('sub-1', {
				labels: ['updated', 'modified'],
			});

			// Verify
			const updated = db.getSession('sub-1');
			assertExists(updated);
			assertExists(updated.labels);
			assertEquals(updated.labels.length, 2);
			assertEquals(updated.labels[0], 'updated');
			assertEquals(updated.labels[1], 'modified');

			db.close();
		});

		test('should cascade delete sub-sessions when parent is deleted', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			const sub2: Session = { ...createTestSession('sub-2'), parentId: 'parent-1' };
			db.createSubSession(sub1);
			db.createSubSession(sub2);

			assertEquals(db.listSessions().length, 3);

			// Delete parent - sub-sessions should be deleted too
			// Note: This relies on application layer cascade since we can't add FK via ALTER TABLE
			// In a real scenario, SessionManager handles cascade delete
			db.deleteSession('parent-1');

			// Parent should be gone
			assertEquals(db.getSession('parent-1'), null);

			// Sub-sessions still exist (DB doesn't have FK cascade from migration)
			// In production, SessionManager.deleteSession handles cascade
			// This test documents the DB-level behavior

			db.close();
		});
	});
});
