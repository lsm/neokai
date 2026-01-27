/**
 * Extended Session RPC Handlers Tests (Behavior-Driven)
 *
 * REFACTORED VERSION - Phase 2
 * Tests RPC handlers through pure behavior testing:
 * - No direct ctx.sessionManager calls
 * - No direct ctx.db verification
 * - All operations via call RPC
 * - All verification via subsequent RPC calls
 *
 * Original tests covered:
 * - session.archive, session.update, session.list
 * - session.model.get, session.model.switch
 * - session.create with config, session.delete
 * - session.thinking.set, worktree.cleanup
 * - models.list, models.clearCache
 * - agent.getState, session.get, client.interrupt
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import { createSession, getSession, listSessions } from '../helpers/rpc-behavior-helpers';

describe('Session RPC Handlers - Extended (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.archive', () => {
		test('should archive a session', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-archive',
			});

			// ✅ Archive via RPC
			const archiveResult = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId,
				confirmed: true,
			});

			expect(archiveResult.success).toBe(true);

			// ✅ Verify via RPC (not ctx.db)
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.status).toBe('archived');

			// ✅ Verify archived session appears in filtered list
			const archivedSessions = await listSessions(ctx.messageHub, 'archived');
			const ids = archivedSessions.map((s) => s.id);
			expect(ids).toContain(sessionId);
		});

		test('should error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.archive', {
					sessionId: 'non-existent-id',
					confirmed: true,
				})
			).rejects.toThrow();
		});
	});

	describe('session.update', () => {
		test('should update session title', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-update-title',
			});

			// ✅ Update via RPC
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				title: 'New Title',
			});

			// ✅ Verify via RPC
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.title).toBe('New Title');
		});

		test('should update session config', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-update-config',
			});

			// ✅ Update config via RPC
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				config: {
					autoScroll: false,
				},
			});

			// ✅ Verify via RPC
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.autoScroll).toBe(false);
		});
	});

	describe('session.list', () => {
		test('should list all sessions', async () => {
			// ✅ Create sessions via RPC
			const sessionId1 = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-list-1',
			});

			const sessionId2 = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-list-2',
			});

			// ✅ List via RPC
			const sessions = await listSessions(ctx.messageHub);

			const sessionIds = sessions.map((s) => s.id);
			expect(sessionIds).toContain(sessionId1);
			expect(sessionIds).toContain(sessionId2);
		});
	});

	describe('session.model.get', () => {
		test('should get current model info', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-model-get',
			});

			// ✅ Get model via RPC
			const modelInfo = await callRPCHandler(ctx.messageHub, 'session.model.get', {
				sessionId,
			});

			expect(modelInfo.currentModel).toBeDefined();
			expect(typeof modelInfo.currentModel).toBe('string');
		});

		test('should error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.model.get', {
					sessionId: 'non-existent',
				})
			).rejects.toThrow();
		});
	});

	describe('session.model.switch', () => {
		test('should switch model using alias', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-model-switch',
			});

			// ✅ Switch via RPC
			const switchResult = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			expect(switchResult.success).toBe(true);

			// ✅ Verify via RPC
			const modelInfo = await callRPCHandler(ctx.messageHub, 'session.model.get', {
				sessionId,
			});
			expect(modelInfo.currentModel).toContain('haiku');
		});

		test('should error for invalid model', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-model-switch-invalid',
			});

			// ✅ Try invalid switch via RPC
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'invalid-model-id',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('session.create with config', () => {
		test('should create session with config', async () => {
			// ✅ Create with config via RPC
			const createResult = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: '/test/session-with-config',
				config: {
					permissionMode: 'acceptEdits',
				},
			});

			expect(createResult.sessionId).toBeDefined();

			// ✅ Verify config via RPC
			const session = await getSession(ctx.messageHub, createResult.sessionId);
			expect(session.config.permissionMode).toBe('acceptEdits');
		});
	});

	describe('session.delete', () => {
		test('should delete session', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-delete',
			});

			// ✅ Delete via RPC
			const deleteResult = await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId,
			});

			expect(deleteResult.success).toBe(true);

			// ✅ Verify deletion via RPC (should error)
			await expect(getSession(ctx.messageHub, sessionId)).rejects.toThrow('Session not found');
		});
	});

	describe('session.thinking.set', () => {
		test('should set thinking level', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-thinking',
			});

			// ✅ Set thinking level via RPC
			const result = await callRPCHandler(ctx.messageHub, 'session.thinking.set', {
				sessionId,
				level: 'think8k',
			});

			expect(result.success).toBe(true);
			expect(result.thinkingLevel).toBe('think8k');
		});

		test('should default to auto for invalid level', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-thinking-invalid',
			});

			// ✅ Set invalid level via RPC
			const result = await callRPCHandler(ctx.messageHub, 'session.thinking.set', {
				sessionId,
				level: 'invalid',
			});

			expect(result.thinkingLevel).toBe('auto');
		});

		test('should error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.thinking.set', {
					sessionId: 'non-existent',
					level: 'think8k',
				})
			).rejects.toThrow();
		});
	});

	describe('worktree.cleanup', () => {
		test('should return success with empty cleanedPaths', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'worktree.cleanup', {
				workspacePath: '/test/workspace',
			});

			expect(result.success).toBe(true);
			expect(result.cleanedPaths).toBeArray();
			expect(result.message).toContain('orphaned worktree');
		});

		test('should work without workspacePath', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'worktree.cleanup', {});

			expect(result.success).toBe(true);
		});
	});

	describe('models.list', () => {
		test('should list available models', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.list', {});

			expect(result.models).toBeArray();
			expect(result.models.length).toBeGreaterThan(0);
			expect(result.models[0]).toHaveProperty('id');
			expect(result.models[0]).toHaveProperty('display_name');
		});

		test('should support forceRefresh parameter', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.list', {
				forceRefresh: true,
			});

			expect(result.cached).toBe(false);
		});

		test('should support useCache parameter', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: false,
			});

			expect(result.cached).toBe(false);
		});
	});

	describe('models.clearCache', () => {
		test('should clear model cache', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.clearCache', {});

			expect(result.success).toBe(true);
		});
	});

	describe('agent.getState', () => {
		test('should get agent state', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/agent-state',
			});

			// ✅ Get state via RPC
			const result = await callRPCHandler(ctx.messageHub, 'agent.getState', { sessionId });

			expect(result.state).toBeDefined();
		});

		test('should error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'agent.getState', {
					sessionId: 'non-existent',
				})
			).rejects.toThrow();
		});
	});

	describe('session.get', () => {
		test('should get session details', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/session-get',
			});

			// ✅ Get session via RPC
			const session = await getSession(ctx.messageHub, sessionId);

			expect(session).toBeDefined();
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe('/test/session-get');
		});
	});

	describe('client.interrupt', () => {
		test('should accept interrupt request', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: '/test/client-interrupt',
			});

			// ✅ Interrupt via RPC
			const result = await callRPCHandler(ctx.messageHub, 'client.interrupt', { sessionId });

			expect(result.accepted).toBe(true);
		});

		test('should error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'client.interrupt', {
					sessionId: 'non-existent',
				})
			).rejects.toThrow();
		});
	});
});
