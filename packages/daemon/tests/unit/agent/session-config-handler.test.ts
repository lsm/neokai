/**
 * SessionConfigHandler Tests
 *
 * Tests session configuration and metadata update logic.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SessionConfigHandler,
	type SessionConfigHandlerContext,
} from '../../../src/lib/agent/session-config-handler';
import type { Session } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import { SettingsManager } from '../../../src/lib/settings-manager';
import { generateUUID } from '@liuboer/shared';

describe('SessionConfigHandler', () => {
	let handler: SessionConfigHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockDaemonHub: DaemonHub;
	let mockSettingsManager: SettingsManager;

	let updateSessionSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		const sessionId = generateUUID();

		// Create base mock session
		mockSession = {
			id: sessionId,
			title: 'Test Session',
			workspacePath: '/test/workspace',
			status: 'active',
			createdAt: Date.now(),
			config: {
				model: 'default',
			},
			metadata: {
				someField: 'someValue',
			},
		} as Session;

		// Create mock spies
		updateSessionSpy = mock(() => {});
		emitSpy = mock(async () => {});

		// Create mock db
		mockDb = {
			updateSession: updateSessionSpy,
		} as unknown as Database;

		// Create mock daemonHub
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// Create mock settings manager
		mockSettingsManager = {} as SettingsManager;

		// Create context
		const ctx: SessionConfigHandlerContext = {
			session: mockSession,
			db: mockDb,
			daemonHub: mockDaemonHub,
			settingsManager: mockSettingsManager,
		};

		handler = new SessionConfigHandler(ctx);
	});

	describe('updateConfig', () => {
		it('should merge config updates with existing config', async () => {
			await handler.updateConfig({ model: 'opus' });

			expect(mockSession.config.model).toBe('opus');
		});

		it('should preserve existing config fields not being updated', async () => {
			mockSession.config = { model: 'default', maxTokens: 4096 } as Session['config'];

			await handler.updateConfig({ model: 'haiku' });

			expect(mockSession.config.model).toBe('haiku');
			expect(mockSession.config.maxTokens).toBe(4096);
		});

		it('should persist config to database', async () => {
			await handler.updateConfig({ model: 'opus' });

			expect(updateSessionSpy).toHaveBeenCalledTimes(1);
			expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
				config: mockSession.config,
			});
		});

		it('should emit session.updated event', async () => {
			await handler.updateConfig({ model: 'opus' });

			expect(emitSpy).toHaveBeenCalledTimes(1);
			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: mockSession.id,
				source: 'config-update',
				session: { config: mockSession.config },
			});
		});
	});

	describe('updateMetadata', () => {
		it('should update title', () => {
			handler.updateMetadata({ title: 'New Title' });

			expect(mockSession.title).toBe('New Title');
		});

		it('should update status', () => {
			handler.updateMetadata({ status: 'archived' });

			expect(mockSession.status).toBe('archived');
		});

		it('should update archivedAt', () => {
			const timestamp = Date.now();
			handler.updateMetadata({ archivedAt: timestamp });

			expect(mockSession.archivedAt).toBe(timestamp);
		});

		it('should update worktree', () => {
			const worktree = {
				enabled: true,
				path: '/worktree/path',
				branch: 'feature-branch',
			};
			handler.updateMetadata({ worktree });

			expect(mockSession.worktree).toEqual(worktree);
		});

		it('should merge metadata fields', () => {
			mockSession.metadata = { existingField: 'value', toUpdate: 'old' };

			handler.updateMetadata({ metadata: { toUpdate: 'new', newField: 'added' } });

			expect(mockSession.metadata).toEqual({
				existingField: 'value',
				toUpdate: 'new',
				newField: 'added',
			});
		});

		it('should delete metadata fields when value is null', () => {
			mockSession.metadata = { field1: 'value1', field2: 'value2' };

			handler.updateMetadata({ metadata: { field1: null } as unknown as Session['metadata'] });

			expect(mockSession.metadata.field1).toBeUndefined();
			expect(mockSession.metadata.field2).toBe('value2');
		});

		it('should delete metadata fields when value is undefined', () => {
			mockSession.metadata = { field1: 'value1', field2: 'value2' };

			handler.updateMetadata({
				metadata: { field1: undefined } as unknown as Session['metadata'],
			});

			expect(mockSession.metadata.field1).toBeUndefined();
			expect(mockSession.metadata.field2).toBe('value2');
		});

		it('should merge config updates', () => {
			mockSession.config = { model: 'default', maxTokens: 4096 } as Session['config'];

			handler.updateMetadata({ config: { model: 'opus' } as Session['config'] });

			expect(mockSession.config.model).toBe('opus');
			expect(mockSession.config.maxTokens).toBe(4096);
		});

		it('should persist updates to database', () => {
			const updates = { title: 'Updated Title' };
			handler.updateMetadata(updates);

			expect(updateSessionSpy).toHaveBeenCalledTimes(1);
			expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, updates);
		});

		it('should update workspacePath and recreate settingsManager', () => {
			const ctx = handler as unknown as { ctx: SessionConfigHandlerContext };
			const originalSettingsManager = ctx.ctx.settingsManager;

			handler.updateMetadata({ workspacePath: '/new/workspace' });

			expect(mockSession.workspacePath).toBe('/new/workspace');
			// SettingsManager should be recreated (different instance)
			expect(ctx.ctx.settingsManager).not.toBe(originalSettingsManager);
			expect(ctx.ctx.settingsManager).toBeInstanceOf(SettingsManager);
		});
	});
});
