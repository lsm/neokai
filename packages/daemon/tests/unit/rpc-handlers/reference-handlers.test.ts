/**
 * Tests for Reference RPC Handlers
 *
 * Tests the `reference.resolve` RPC handler:
 * - Task resolution (with room context, without room context, missing task)
 * - Goal resolution (with room context, without room context, missing goal, wrong room)
 * - File resolution (normal, truncated, missing, path traversal)
 * - Folder resolution (normal, missing, path traversal)
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	setupReferenceHandlers,
	type ReferenceHandlerDeps,
	type TaskRepoForReference,
	type GoalRepoForReference,
} from '../../../src/lib/rpc-handlers/reference-handlers';

// Type for captured request handlers
type RequestHandler = (data: unknown) => Promise<unknown>;

// ============================================================================
// Helpers
// ============================================================================

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

function makeSessionManager(opts: { workspacePath: string; roomId?: string; exists?: boolean }) {
	const exists = opts.exists ?? true;

	const session = exists
		? {
				getSessionData: () => ({
					id: 'session-1',
					workspacePath: opts.workspacePath,
					context: opts.roomId ? { roomId: opts.roomId } : undefined,
				}),
			}
		: null;

	return {
		getSessionAsync: mock(async () => session),
	};
}

const SAMPLE_TASK = {
	id: 'task-uuid-1',
	roomId: 'room-1',
	title: 'Fix bug',
	status: 'pending',
};

const SAMPLE_GOAL = {
	id: 'goal-uuid-1',
	roomId: 'room-1',
	title: 'Ship feature',
	status: 'active',
};

function makeTaskRepo(task: typeof SAMPLE_TASK | null = SAMPLE_TASK): TaskRepoForReference {
	return {
		getTask: mock((id: string) => (task && id === task.id ? task : null)),
		getTaskByShortId: mock((_roomId: string, shortId: string) =>
			task && shortId === 't-1' ? task : null
		),
	};
}

function makeGoalRepo(goal: typeof SAMPLE_GOAL | null = SAMPLE_GOAL): GoalRepoForReference {
	return {
		getGoal: mock((id: string) => (goal && id === goal.id ? goal : null)),
		getGoalByShortId: mock((_roomId: string, shortId: string) =>
			goal && shortId === 'g-1' ? goal : null
		),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('reference.resolve handler', () => {
	let testWorkspace: string;

	beforeEach(async () => {
		testWorkspace = join(
			tmpdir(),
			`ref-handlers-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await mkdir(testWorkspace, { recursive: true });
	});

	afterEach(async () => {
		await rm(testWorkspace, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// Validation
	// -------------------------------------------------------------------------

	describe('parameter validation', () => {
		it('throws when sessionId is missing', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			await expect(handler({ sessionId: '', type: 'task', id: 'x' })).rejects.toThrow(
				'sessionId is required'
			);
		});

		it('throws when type is missing', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			await expect(handler({ sessionId: 'session-1', type: '', id: 'x' })).rejects.toThrow(
				'type is required'
			);
		});

		it('throws when id is missing', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			await expect(handler({ sessionId: 'session-1', type: 'task', id: '' })).rejects.toThrow(
				'id is required'
			);
		});
	});

	// -------------------------------------------------------------------------
	// Task resolution
	// -------------------------------------------------------------------------

	describe('task resolution', () => {
		it('returns task data for a valid UUID in room context', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'task',
				id: 'task-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toMatchObject({
				type: 'task',
				id: 'task-uuid-1',
				data: { id: 'task-uuid-1', title: 'Fix bug' },
			});
		});

		it('resolves task by short ID', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'task',
				id: 't-1',
			})) as { resolved: unknown };

			expect(result.resolved).toMatchObject({
				type: 'task',
				id: 't-1',
				data: { id: 'task-uuid-1', title: 'Fix bug' },
			});
		});

		it('returns null when no room context', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					// no roomId
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'task',
				id: 'task-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null when task does not exist', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(null),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'task',
				id: 'non-existent',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null when session does not exist', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
					exists: false,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'unknown-session',
				type: 'task',
				id: 'task-uuid-1',
			})) as { resolved: unknown };

			// Session not found → no roomId → null
			expect(result.resolved).toBeNull();
		});

		it('returns null when task belongs to a different room (cross-room isolation)', async () => {
			const taskInOtherRoom = { ...SAMPLE_TASK, roomId: 'other-room' };
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(taskInOtherRoom),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'task',
				id: 'task-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// Goal resolution
	// -------------------------------------------------------------------------

	describe('goal resolution', () => {
		it('returns goal data for a valid UUID in room context', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'goal',
				id: 'goal-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toMatchObject({
				type: 'goal',
				id: 'goal-uuid-1',
				data: { id: 'goal-uuid-1', title: 'Ship feature' },
			});
		});

		it('resolves goal by short ID', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'goal',
				id: 'g-1',
			})) as { resolved: unknown };

			expect(result.resolved).toMatchObject({
				type: 'goal',
				id: 'g-1',
				data: { id: 'goal-uuid-1', title: 'Ship feature' },
			});
		});

		it('returns null when no room context', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'goal',
				id: 'goal-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null when goal does not exist', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(null),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'goal',
				id: 'non-existent',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null when goal belongs to a different room', async () => {
			const goalInOtherRoom = { ...SAMPLE_GOAL, roomId: 'other-room' };
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					roomId: 'room-1',
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(goalInOtherRoom),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'goal',
				id: 'goal-uuid-1',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// File resolution
	// -------------------------------------------------------------------------

	describe('file resolution', () => {
		it('returns file content for an existing file', async () => {
			const filePath = join(testWorkspace, 'hello.txt');
			await writeFile(filePath, 'Hello world');

			// DEBUG: verify file and workspace exist
			const { stat } = await import('node:fs/promises');
			expect(testWorkspace).toBeTruthy();
			expect(testWorkspace.length).toBeGreaterThan(0);
			const wsStat = await stat(testWorkspace);
			expect(wsStat.isDirectory()).toBe(true);
			const fileStat = await stat(filePath);
			expect(fileStat.size).toBe(11);
			// eslint-disable-next-line no-console
			(globalThis as unknown as Record<string, unknown>).__originalConsole.log(
				`DEBUG file resolution: testWorkspace="${testWorkspace}" filePath="${filePath}" wsOK=true fileOK=true`
			);

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'file',
				id: 'hello.txt',
			})) as {
				resolved: {
					type: string;
					id: string;
					data: { content: string; binary: boolean; truncated: boolean; size: number };
				};
			};

			// eslint-disable-next-line no-console
			(globalThis as unknown as Record<string, unknown>).__originalConsole.log(
				`DEBUG result: ${JSON.stringify(result)}`
			);
			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.type).toBe('file');
			expect(result.resolved!.id).toBe('hello.txt');
			expect(result.resolved!.data.content).toBe('Hello world');
			expect(result.resolved!.data.binary).toBe(false);
			expect(result.resolved!.data.truncated).toBe(false);
			expect(result.resolved!.data.size).toBeGreaterThan(0);
		});

		it('truncates large files', async () => {
			// 60 KB file — larger than 50 KB limit
			const bigContent = 'A'.repeat(60_000);
			await writeFile(join(testWorkspace, 'big.txt'), bigContent);

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'file',
				id: 'big.txt',
			})) as {
				resolved: {
					data: { content: string; truncated: boolean };
				};
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.data.truncated).toBe(true);
			expect(result.resolved!.data.content.length).toBe(50_000);
		});

		it('returns binary metadata (no content) for binary files', async () => {
			// Write a buffer with null bytes — clear binary indicator
			const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47, 0x00]);
			await writeFile(join(testWorkspace, 'image.png'), binaryData);

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'file',
				id: 'image.png',
			})) as {
				resolved: { data: { content: null; binary: boolean; size: number } } | null;
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.data.binary).toBe(true);
			expect(result.resolved!.data.content).toBeNull();
			expect(result.resolved!.data.size).toBeGreaterThan(0);
		});

		it('returns null for a missing file', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'file',
				id: 'does-not-exist.txt',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null for path traversal attempts', async () => {
			// Create a file outside the workspace so we know it exists
			const outsideDir = join(
				tmpdir(),
				`outside-${Date.now()}-${Math.random().toString(36).slice(2)}`
			);
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, 'secret.txt'), 'secret');

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'file',
				id: '../secret.txt',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();

			await rm(outsideDir, { recursive: true, force: true });
		});
	});

	// -------------------------------------------------------------------------
	// Folder resolution
	// -------------------------------------------------------------------------

	describe('folder resolution', () => {
		it('returns folder entries for an existing directory', async () => {
			await mkdir(join(testWorkspace, 'src'), { recursive: true });
			await writeFile(join(testWorkspace, 'src', 'index.ts'), '// entry');
			await writeFile(join(testWorkspace, 'src', 'utils.ts'), '// utils');

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'folder',
				id: 'src',
			})) as {
				resolved: {
					type: string;
					id: string;
					data: { path: string; entries: Array<{ name: string }> };
				};
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.type).toBe('folder');
			expect(result.resolved!.id).toBe('src');
			expect(result.resolved!.data.path).toBe('src');
			const names = result.resolved!.data.entries.map((e) => e.name);
			expect(names).toContain('index.ts');
			expect(names).toContain('utils.ts');
		});

		it('returns null for a missing directory', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'folder',
				id: 'non-existent-dir',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});

		it('returns null for path traversal attempts on folders', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({ workspacePath: testWorkspace }) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'session-1',
				type: 'folder',
				id: '../',
			})) as { resolved: unknown };

			expect(result.resolved).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// Fallback / session handling
	// -------------------------------------------------------------------------

	describe('session fallback', () => {
		it('uses workspaceRoot when session is not found', async () => {
			await writeFile(join(testWorkspace, 'fallback.txt'), 'fallback content');

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					exists: false,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'unknown-session',
				type: 'file',
				id: 'fallback.txt',
			})) as {
				resolved: { data: { content: string } } | null;
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.data.content).toBe('fallback content');
		});
	});

	// -------------------------------------------------------------------------
	// room:chat:* session resolution
	// -------------------------------------------------------------------------

	describe('room:chat session resolution', () => {
		it('resolves workspace from room defaultPath for room:chat:<roomId> sessions', async () => {
			const roomWorkspace = join(
				tmpdir(),
				`room-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`
			);
			await mkdir(roomWorkspace, { recursive: true });
			await writeFile(join(roomWorkspace, 'room-file.txt'), 'room content');

			try {
				const { hub, handlers } = createMockMessageHub();
				const deps: ReferenceHandlerDeps = {
					sessionManager: makeSessionManager({
						workspacePath: testWorkspace,
						exists: false,
					}) as never,
					taskRepo: makeTaskRepo(),
					goalRepo: makeGoalRepo(),
					workspaceRoot: testWorkspace,
					getRoomDefaultPath: (roomId: string) =>
						roomId === 'room-42' ? roomWorkspace : undefined,
				};
				setupReferenceHandlers(hub, deps);
				const handler = handlers.get('reference.resolve')!;

				const result = (await handler({
					sessionId: 'room:chat:room-42',
					type: 'file',
					id: 'room-file.txt',
				})) as {
					resolved: { data: { content: string } } | null;
				};

				expect(result.resolved).not.toBeNull();
				expect(result.resolved!.data.content).toBe('room content');
			} finally {
				await rm(roomWorkspace, { recursive: true, force: true });
			}
		});

		it('falls back to workspaceRoot when room is not found (deleted room)', async () => {
			await writeFile(join(testWorkspace, 'fallback.txt'), 'fallback content');

			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					exists: false,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
				getRoomDefaultPath: (_roomId: string) => undefined, // room not found
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'room:chat:deleted-room',
				type: 'file',
				id: 'fallback.txt',
			})) as {
				resolved: { data: { content: string } } | null;
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.data.content).toBe('fallback content');
		});

		it('falls back to workspaceRoot when getRoomDefaultPath is not provided', async () => {
			await writeFile(join(testWorkspace, 'fallback.txt'), 'fallback content');

			const { hub, handlers } = createMockMessageHub();
			// No getRoomDefaultPath in deps (omitted)
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					exists: false,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'room:chat:some-room',
				type: 'file',
				id: 'fallback.txt',
			})) as {
				resolved: { data: { content: string } } | null;
			};

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.data.content).toBe('fallback content');
		});

		it('extracts correct roomId from room:chat:<roomId> for task resolution', async () => {
			const { hub, handlers } = createMockMessageHub();
			const deps: ReferenceHandlerDeps = {
				sessionManager: makeSessionManager({
					workspacePath: testWorkspace,
					exists: false,
				}) as never,
				taskRepo: makeTaskRepo(),
				goalRepo: makeGoalRepo(),
				workspaceRoot: testWorkspace,
				getRoomDefaultPath: (roomId: string) => (roomId === 'room-1' ? testWorkspace : undefined),
			};
			setupReferenceHandlers(hub, deps);
			const handler = handlers.get('reference.resolve')!;

			const result = (await handler({
				sessionId: 'room:chat:room-1',
				type: 'task',
				id: 'task-uuid-1',
			})) as { resolved: unknown };

			// Task belongs to room-1 — should resolve successfully
			expect(result.resolved).toMatchObject({
				type: 'task',
				id: 'task-uuid-1',
				data: { id: 'task-uuid-1', title: 'Fix bug' },
			});
		});
	});
});
