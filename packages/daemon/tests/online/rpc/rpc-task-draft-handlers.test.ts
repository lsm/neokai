/**
 * Task Draft RPC Handlers Tests
 *
 * Tests for input draft persistence via task.updateDraft RPC:
 * - Successful draft save and retrieval via task.get
 * - Validation error when draft is too long (> 100,000 chars)
 * - Error when task doesn't exist
 * - Error when task doesn't belong to the room
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { NeoTask } from '@neokai/shared';

describe('Task Draft RPC Handlers', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 15_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	});

	async function createRoom(name: string): Promise<string> {
		const result = (await daemon.messageHub.request('room.create', {
			name: `${name} ${Date.now()}`,
		})) as { room: { id: string } };
		return result.room.id;
	}

	async function createTask(roomId: string, title: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.create', {
			roomId,
			title,
			description: 'Test task description',
		})) as { task: NeoTask };
		return result.task;
	}

	async function getTask(roomId: string, taskId: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.get', {
			roomId,
			taskId,
		})) as { task: NeoTask };
		return result.task;
	}

	describe('task.updateDraft — successful save and retrieval', () => {
		test('should save draft and retrieve it via task.get', async () => {
			const roomId = await createRoom('draft-save');
			const task = await createTask(roomId, 'Test task for draft');

			const result = (await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: 'My draft content',
			})) as { success: boolean };

			expect(result.success).toBe(true);

			const fetchedTask = await getTask(roomId, task.id);
			expect(fetchedTask.inputDraft).toBe('My draft content');
		});

		test('should overwrite an existing draft', async () => {
			const roomId = await createRoom('draft-overwrite');
			const task = await createTask(roomId, 'Test task for overwrite');

			await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: 'First draft',
			});

			await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: 'Second draft',
			});

			const fetchedTask = await getTask(roomId, task.id);
			expect(fetchedTask.inputDraft).toBe('Second draft');
		});

		test('should clear draft when null is passed', async () => {
			const roomId = await createRoom('draft-clear');
			const task = await createTask(roomId, 'Test task for clear');

			await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: 'Draft to clear',
			});

			await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: null,
			});

			const fetchedTask = await getTask(roomId, task.id);
			expect(fetchedTask.inputDraft == null).toBe(true);
		});

		test('should accept draft at max length (100,000 chars)', async () => {
			const roomId = await createRoom('draft-max-length');
			const task = await createTask(roomId, 'Test task for max length');

			const maxDraft = 'a'.repeat(100_000);

			const result = (await daemon.messageHub.request('task.updateDraft', {
				roomId,
				taskId: task.id,
				draft: maxDraft,
			})) as { success: boolean };

			expect(result.success).toBe(true);

			const fetchedTask = await getTask(roomId, task.id);
			expect(fetchedTask.inputDraft).toBe(maxDraft);
		});
	});

	describe('task.updateDraft — validation errors', () => {
		test('should reject draft longer than 100,000 characters', async () => {
			const roomId = await createRoom('draft-too-long');
			const task = await createTask(roomId, 'Test task for too long draft');

			const tooLongDraft = 'a'.repeat(100_001);

			await expect(
				daemon.messageHub.request('task.updateDraft', {
					roomId,
					taskId: task.id,
					draft: tooLongDraft,
				})
			).rejects.toThrow('Draft is too long (max 100,000 characters)');
		});

		test('should reject when roomId is missing', async () => {
			await expect(
				daemon.messageHub.request('task.updateDraft', {
					roomId: '',
					taskId: 'some-task-id',
					draft: 'content',
				})
			).rejects.toThrow('Room ID is required');
		});

		test('should reject when taskId is missing', async () => {
			const roomId = await createRoom('draft-missing-task-id');

			await expect(
				daemon.messageHub.request('task.updateDraft', {
					roomId,
					taskId: '',
					draft: 'content',
				})
			).rejects.toThrow('Task ID is required');
		});
	});

	describe('task.updateDraft — ownership checks', () => {
		test('should return error when task does not exist', async () => {
			const roomId = await createRoom('draft-nonexistent');

			await expect(
				daemon.messageHub.request('task.updateDraft', {
					roomId,
					taskId: 'non-existent-task-id',
					draft: 'content',
				})
			).rejects.toThrow(/Task not found/);
		});

		test('should return error when task belongs to a different room', async () => {
			const roomA = await createRoom('draft-room-a');
			const roomB = await createRoom('draft-room-b');

			// Create task in room A
			const task = await createTask(roomA, 'Task in room A');

			// Try to update draft using room B — should fail because task is not in room B
			await expect(
				daemon.messageHub.request('task.updateDraft', {
					roomId: roomB,
					taskId: task.id,
					draft: 'should fail',
				})
			).rejects.toThrow(/Task not found/);
		});
	});
});
