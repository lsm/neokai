/**
 * Unit tests for task dependency enforcement gap fixes:
 *
 * Gap 1: Adding `dependsOn` to an in_progress task blocks it if deps aren't met.
 * Gap 2: Completing a task auto-unblocks dependents blocked by 'dependency_failed'.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';

const SPACE_ID = 'space-dep-test';

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
	return db;
}

describe('Gap 1: updateTask dependency re-check', () => {
	let db: BunDatabase;
	let taskRepo: SpaceTaskRepository;
	let taskManager: SpaceTaskManager;

	beforeEach(() => {
		db = makeDb();
		taskRepo = new SpaceTaskRepository(db);
		taskManager = new SpaceTaskManager(db, SPACE_ID);
	});
	afterEach(() => {
		db.close();
	});

	test('adding dependsOn to an in_progress task blocks it if deps are not met', async () => {
		// Create a prerequisite task that is NOT done yet
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'open',
		});

		// Create a task without deps and start it
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
		});

		// Add dependency to the running task
		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq.id],
		});

		expect(updated.status).toBe('blocked');
		expect(updated.blockReason).toBe('dependency_added');
	});

	test('adding dependsOn to an in_progress task does NOT block if deps are already done', async () => {
		// Create a prerequisite task that IS done
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'done',
		});

		// Create a task without deps and start it
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
		});

		// Add dependency to the running task — should remain in_progress
		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq.id],
		});

		expect(updated.status).toBe('in_progress');
	});

	test('adding dependsOn to an open task does NOT block it (tick loop handles it)', async () => {
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'open',
		});

		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'open',
		});

		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq.id],
		});

		// Open tasks remain open — tick loop skips them via areDependenciesMet
		expect(updated.status).toBe('open');
	});

	test('updating dependsOn without changing the value does not re-check', async () => {
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'open',
		});

		// Create task with existing dep
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
			dependsOn: [prereq.id],
		});

		// Re-send the same dependsOn — should be a no-op (no re-check)
		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq.id],
		});

		// Should remain in_progress because the dep array didn't actually change
		expect(updated.status).toBe('in_progress');
	});

	test('changing dependsOn to a different unmet dep blocks the task', async () => {
		const prereq1 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 1',
			description: '',
			status: 'done',
		});
		const prereq2 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 2',
			description: '',
			status: 'open',
		});

		// Create task with met dep
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
			dependsOn: [prereq1.id],
		});

		// Change dep to an unmet one
		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq2.id],
		});

		expect(updated.status).toBe('blocked');
		expect(updated.blockReason).toBe('dependency_added');
	});

	test('changing dependsOn to a met dep keeps task in_progress', async () => {
		const prereq1 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 1',
			description: '',
			status: 'open',
		});
		const prereq2 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 2',
			description: '',
			status: 'done',
		});

		// Create task with unmet dep
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
			dependsOn: [prereq1.id],
		});

		// Change dep to a met one
		const updated = await taskManager.updateTask(task.id, {
			dependsOn: [prereq2.id],
		});

		expect(updated.status).toBe('in_progress');
	});
});

describe('Gap 2: done -> unblock dependents cascade', () => {
	let db: BunDatabase;
	let taskRepo: SpaceTaskRepository;
	let taskManager: SpaceTaskManager;

	beforeEach(() => {
		db = makeDb();
		taskRepo = new SpaceTaskRepository(db);
		taskManager = new SpaceTaskManager(db, SPACE_ID);
	});
	afterEach(() => {
		db.close();
	});

	test('completing a task unblocks dependents blocked with dependency_failed', async () => {
		// Create the prerequisite (in_progress so it can transition to done)
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'in_progress',
		});

		// Create a dependent task that was blocked because its dep failed
		const dependent = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Dependent',
			description: '',
			status: 'blocked',
			dependsOn: [prereq.id],
		});
		taskRepo.updateTask(dependent.id, {
			blockReason: 'dependency_failed',
		});

		// Complete the prerequisite
		await taskManager.setTaskStatus(prereq.id, 'done');

		// Run the unblock cascade
		const unblocked = await taskManager.unblockDependentTasks(prereq.id);

		expect(unblocked).toHaveLength(1);
		expect(unblocked[0].id).toBe(dependent.id);
		expect(unblocked[0].status).toBe('open');
	});

	test('dependent with multiple deps stays blocked if not all are done', async () => {
		// Create two prerequisites
		const prereq1 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 1',
			description: '',
			status: 'in_progress',
		});
		const prereq2 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 2',
			description: '',
			status: 'open',
		});

		// Create a dependent task blocked because deps failed
		const dependent = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Dependent',
			description: '',
			status: 'blocked',
			dependsOn: [prereq1.id, prereq2.id],
		});
		taskRepo.updateTask(dependent.id, {
			blockReason: 'dependency_failed',
		});

		// Complete only prereq1 — prereq2 is still open
		await taskManager.setTaskStatus(prereq1.id, 'done');

		const unblocked = await taskManager.unblockDependentTasks(prereq1.id);
		expect(unblocked).toHaveLength(0);

		// Dependent should still be blocked
		const stillDependent = await taskManager.getTask(dependent.id);
		expect(stillDependent!.status).toBe('blocked');
	});

	test('dependent with all deps done gets unblocked', async () => {
		const prereq1 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 1',
			description: '',
			status: 'done',
		});
		const prereq2 = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prereq 2',
			description: '',
			status: 'in_progress',
		});

		const dependent = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Dependent',
			description: '',
			status: 'blocked',
			dependsOn: [prereq1.id, prereq2.id],
		});
		taskRepo.updateTask(dependent.id, {
			blockReason: 'dependency_failed',
		});

		// Complete prereq2 — now both deps are done
		await taskManager.setTaskStatus(prereq2.id, 'done');

		const unblocked = await taskManager.unblockDependentTasks(prereq2.id);
		expect(unblocked).toHaveLength(1);
		expect(unblocked[0].status).toBe('open');
	});

	test('non-dependency blocked tasks are NOT affected', async () => {
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'in_progress',
		});

		const blockedForOtherReason = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Other blocked',
			description: '',
			status: 'blocked',
			dependsOn: [prereq.id],
		});
		taskRepo.updateTask(blockedForOtherReason.id, {
			blockReason: 'agent_crashed',
		});

		await taskManager.setTaskStatus(prereq.id, 'done');

		const unblocked = await taskManager.unblockDependentTasks(prereq.id);
		expect(unblocked).toHaveLength(0);
	});

	test('dependency_added blocked tasks are also unblocked', async () => {
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'open',
		});

		// Simulate a task that was blocked via the Gap 1 fix (dependency_added)
		const dependent = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Dependent',
			description: '',
			status: 'blocked',
			dependsOn: [prereq.id],
		});
		taskRepo.updateTask(dependent.id, {
			blockReason: 'dependency_added',
		});

		// Complete the prerequisite
		await taskManager.setTaskStatus(prereq.id, 'done');

		const unblocked = await taskManager.unblockDependentTasks(prereq.id);
		expect(unblocked).toHaveLength(1);
		expect(unblocked[0].status).toBe('open');
	});

	test('no dependents returns empty array', async () => {
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'done',
		});

		const unblocked = await taskManager.unblockDependentTasks(prereq.id);
		expect(unblocked).toHaveLength(0);
	});
});

describe('End-to-end: dependency_added -> dep done -> unblock -> tick-loop eligible', () => {
	let db: BunDatabase;
	let taskRepo: SpaceTaskRepository;
	let taskManager: SpaceTaskManager;

	beforeEach(() => {
		db = makeDb();
		taskRepo = new SpaceTaskRepository(db);
		taskManager = new SpaceTaskManager(db, SPACE_ID);
	});
	afterEach(() => {
		db.close();
	});

	test('full lifecycle: add dep to running task -> block -> complete dep -> unblock', async () => {
		// Step 1: Create a running task without deps
		const prereq = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Prerequisite',
			description: '',
			status: 'open',
		});

		const worker = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Worker',
			description: '',
			status: 'in_progress',
		});

		// Step 2: Add dependency — worker gets blocked
		const afterAdd = await taskManager.updateTask(worker.id, {
			dependsOn: [prereq.id],
		});
		expect(afterAdd.status).toBe('blocked');
		expect(afterAdd.blockReason).toBe('dependency_added');

		// Step 3: Verify the tick loop would skip this blocked task
		const depsMet = await taskManager.areDependenciesMet(afterAdd);
		expect(depsMet).toBe(false);

		// Step 4: Complete the prerequisite
		await taskManager.setTaskStatus(prereq.id, 'done');

		// Step 5: Unblock dependents
		const unblocked = await taskManager.unblockDependentTasks(prereq.id);
		expect(unblocked).toHaveLength(1);
		expect(unblocked[0].id).toBe(worker.id);
		expect(unblocked[0].status).toBe('open');

		// Step 6: Verify the task is now eligible for the tick loop
		const reopened = await taskManager.getTask(worker.id);
		expect(reopened!.status).toBe('open');
		const nowDepsMet = await taskManager.areDependenciesMet(reopened!);
		expect(nowDepsMet).toBe(true);
	});
});
