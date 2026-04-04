/**
 * Tests for Neo RPC Handlers
 *
 * Covers:
 *   neo.send           — message injection, missing session, provider errors, model errors
 *   neo.history        — paginated history via AgentSession and DB fallback
 *   neo.clearSession   — delegates to NeoAgentManager.clearSession(); surfaces errors
 *   neo.isProvisioned  — returns provisioned:true/false without any LLM call
 *   neo.getSettings    — returns security mode + model from NeoAgentManager
 *   neo.updateSettings — validates and persists settings via SettingsManager
 *   neo.confirmAction  — retrieves + executes pending action, injects result message
 *   neo.cancelAction   — removes pending action, injects cancellation message
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupNeoHandlers } from '../../../src/lib/rpc-handlers/neo-handlers';
import { PendingActionStore } from '../../../src/lib/neo/security-tier';
import type { NeoAgentManager } from '../../../src/lib/neo/neo-agent-manager';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { Database } from '../../../src/storage/database';

// ---------------------------------------------------------------------------
// Handler map type
// ---------------------------------------------------------------------------

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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

const MOCK_MESSAGES = [
	{ type: 'user', timestamp: 1000 },
	{ type: 'assistant', timestamp: 2000 },
];

function createMockAgentSession() {
	return {
		getSDKMessages: mock(() => ({ messages: MOCK_MESSAGES, hasMore: false })),
	};
}

function createMockNeoAgentManager(
	session: ReturnType<typeof createMockAgentSession> | null = createMockAgentSession()
) {
	return {
		getSession: mock(() => session),
		healthCheck: mock(async () => true),
		clearSession: mock(async () => {}),
		cleanup: mock(async () => {}),
		provision: mock(async () => {}),
		getSecurityMode: mock(() => 'balanced' as const),
		getModel: mock(() => 'claude-opus-4-6'),
	} as unknown as NeoAgentManager;
}

function createMockSessionManager() {
	return {
		injectMessage: mock(async () => {}),
	} as unknown as SessionManager;
}

function createMockSettingsManager() {
	return {
		updateGlobalSettings: mock(() => ({
			neoSecurityMode: 'balanced',
			neoModel: 'claude-opus-4-6',
		})),
		getGlobalSettings: mock(() => ({
			neoSecurityMode: 'balanced',
			neoModel: 'claude-opus-4-6',
		})),
	} as unknown as SettingsManager;
}

function createMockDb() {
	return {
		getDatabase: mock(() => ({
			prepare: mock(() => ({ all: mock(() => []) })),
		})),
	} as unknown as Database;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Neo RPC Handlers', () => {
	let hubData: ReturnType<typeof createMockMessageHub>;
	let neoManager: ReturnType<typeof createMockNeoAgentManager>;
	let sessionManager: ReturnType<typeof createMockSessionManager>;
	let settingsManager: ReturnType<typeof createMockSettingsManager>;
	let db: ReturnType<typeof createMockDb>;
	let store: PendingActionStore;

	beforeEach(() => {
		hubData = createMockMessageHub();
		neoManager = createMockNeoAgentManager();
		sessionManager = createMockSessionManager();
		settingsManager = createMockSettingsManager();
		db = createMockDb();
		// Fresh store per test — no shared singleton, no private internals access.
		store = new PendingActionStore();

		setupNeoHandlers(hubData.hub, neoManager, sessionManager, settingsManager, db, store);
	});

	afterEach(() => {
		mock.restore();
	});

	// ── neo.send ──────────────────────────────────────────────────────────────

	describe('neo.send', () => {
		it('injects message and returns success', async () => {
			const handler = hubData.handlers.get('neo.send');
			expect(handler).toBeDefined();

			const result = (await handler!({ message: 'Hello Neo' }, {})) as {
				success: boolean;
			};
			expect(result.success).toBe(true);
			// messageId is intentionally not returned (injectMessage returns void)
			expect((result as Record<string, unknown>).messageId).toBeUndefined();
			expect(sessionManager.injectMessage).toHaveBeenCalledTimes(1);
		});

		it('runs health-check before injection', async () => {
			const handler = hubData.handlers.get('neo.send');
			await handler!({ message: 'ping' }, {});
			expect(neoManager.healthCheck).toHaveBeenCalledWith({ source: 'runtime' });
		});

		it('returns NO_CREDENTIALS when session is null', async () => {
			const managerNoSession = createMockNeoAgentManager(null);
			const { hub, handlers } = createMockMessageHub();
			setupNeoHandlers(hub, managerNoSession, sessionManager, settingsManager, db, store);

			const handler = handlers.get('neo.send');
			const result = (await handler!({ message: 'hi' }, {})) as {
				success: boolean;
				errorCode: string;
			};
			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('NO_CREDENTIALS');
		});

		it('returns PROVIDER_ERROR when health-check throws', async () => {
			neoManager.healthCheck = mock(async () => {
				throw new Error('timeout');
			});

			const handler = hubData.handlers.get('neo.send');
			const result = (await handler!({ message: 'hi' }, {})) as {
				success: boolean;
				errorCode: string;
			};
			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('PROVIDER_ERROR');
		});

		it('returns PROVIDER_ERROR when injectMessage throws a rate-limit error', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('rate limit 429');
			});

			const handler = hubData.handlers.get('neo.send');
			const result = (await handler!({ message: 'hi' }, {})) as {
				success: boolean;
				errorCode: string;
			};
			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('PROVIDER_ERROR');
		});

		it('returns PROVIDER_ERROR for 503 server errors', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('server error 503');
			});

			const handler = hubData.handlers.get('neo.send');
			const result = (await handler!({ message: 'hi' }, {})) as {
				success: boolean;
				errorCode: string;
			};
			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('PROVIDER_ERROR');
		});

		it('returns MODEL_UNAVAILABLE when model error occurs', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('model not found: claude-invalid');
			});

			const handler = hubData.handlers.get('neo.send');
			const result = (await handler!({ message: 'hi' }, {})) as {
				success: boolean;
				errorCode: string;
				error: string;
			};
			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('MODEL_UNAVAILABLE');
			expect(result.error).toContain('claude-invalid');
		});

		it('re-throws unknown errors', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('something completely unexpected');
			});

			const handler = hubData.handlers.get('neo.send');
			await expect(handler!({ message: 'hi' }, {})).rejects.toThrow(
				'something completely unexpected'
			);
		});

		it('throws when message is empty', async () => {
			const handler = hubData.handlers.get('neo.send');
			await expect(handler!({ message: '' }, {})).rejects.toThrow('message is required');
		});

		it('throws when message is missing', async () => {
			const handler = hubData.handlers.get('neo.send');
			await expect(handler!({}, {})).rejects.toThrow('message is required');
		});

		it('throws when message is only whitespace', async () => {
			const handler = hubData.handlers.get('neo.send');
			await expect(handler!({ message: '   ' }, {})).rejects.toThrow('message is required');
		});
	});

	// ── neo.history ───────────────────────────────────────────────────────────

	describe('neo.history', () => {
		it('returns messages from AgentSession when available', async () => {
			const handler = hubData.handlers.get('neo.history');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				messages: unknown[];
				hasMore: boolean;
			};
			expect(result.messages).toEqual(MOCK_MESSAGES);
			expect(result.hasMore).toBe(false);
		});

		it('passes limit and before cursor to getSDKMessages', async () => {
			const handler = hubData.handlers.get('neo.history');
			await handler!({ limit: 10, before: 99999 }, {});

			const session = neoManager.getSession();
			expect(session?.getSDKMessages).toHaveBeenCalledWith(10, 99999, undefined);
		});

		it('uses default limit of 50 when not provided', async () => {
			const handler = hubData.handlers.get('neo.history');
			await handler!({}, {});

			const session = neoManager.getSession();
			expect(session?.getSDKMessages).toHaveBeenCalledWith(50, undefined, undefined);
		});

		it('falls back to DB when session is not provisioned', async () => {
			const managerNoSession = createMockNeoAgentManager(null);
			const { hub, handlers } = createMockMessageHub();

			// Mock the DB to return one row.
			const mockRows = [
				{
					sdk_message: JSON.stringify({ type: 'user' }),
					timestamp: '2024-01-01T00:00:00Z',
					send_status: null,
					origin: null,
				},
			];
			const mockDb = {
				getDatabase: mock(() => ({
					prepare: mock(() => ({ all: mock(() => mockRows) })),
				})),
			} as unknown as Database;

			setupNeoHandlers(hub, managerNoSession, sessionManager, settingsManager, mockDb, store);

			const handler = handlers.get('neo.history');
			const result = (await handler!({ limit: 5 }, {})) as {
				messages: unknown[];
				hasMore: boolean;
			};
			// hasMore is false because we got fewer than limit messages
			expect(result.hasMore).toBe(false);
			expect(Array.isArray(result.messages)).toBe(true);
		});
	});

	// ── neo.clearSession ──────────────────────────────────────────────────────

	describe('neo.clearSession', () => {
		it('delegates to neoAgentManager.clearSession()', async () => {
			const handler = hubData.handlers.get('neo.clearSession');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { success: boolean };
			expect(result.success).toBe(true);
			expect(neoManager.clearSession).toHaveBeenCalledTimes(1);
		});

		it('returns success:false with error message when clearSession throws', async () => {
			neoManager.clearSession = mock(async () => {
				throw new Error('provision failed');
			});

			const handler = hubData.handlers.get('neo.clearSession');
			const result = (await handler!({}, {})) as { success: boolean; error?: string };
			expect(result.success).toBe(false);
			expect(result.error).toBe('provision failed');
		});
	});

	// ── neo.isProvisioned ─────────────────────────────────────────────────────

	describe('neo.isProvisioned', () => {
		it('returns provisioned:true when a session exists and LLM is available', async () => {
			const handler = hubData.handlers.get('neo.isProvisioned');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { provisioned: boolean };
			expect(result.provisioned).toBe(true);
		});

		it('returns provisioned:false when session is null (no credentials)', async () => {
			// Use a fresh hub with a manager that returns no session
			const { hub: nullHub, handlers: nullHandlers } = createMockMessageHub();
			const nullNeoManager = createMockNeoAgentManager(null);
			setupNeoHandlers(nullHub, nullNeoManager, sessionManager, settingsManager, db);

			const handler = nullHandlers.get('neo.isProvisioned');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { provisioned: boolean };
			expect(result.provisioned).toBe(false);
		});

		it('returns provisioned:false when NEOKAI_NEO_LLM_AVAILABLE=0 even if session exists', async () => {
			const original = process.env.NEOKAI_NEO_LLM_AVAILABLE;
			process.env.NEOKAI_NEO_LLM_AVAILABLE = '0';
			try {
				const handler = hubData.handlers.get('neo.isProvisioned');
				expect(handler).toBeDefined();

				const result = (await handler!({}, {})) as { provisioned: boolean };
				expect(result.provisioned).toBe(false);
			} finally {
				if (original === undefined) {
					delete process.env.NEOKAI_NEO_LLM_AVAILABLE;
				} else {
					process.env.NEOKAI_NEO_LLM_AVAILABLE = original;
				}
			}
		});
	});

	// ── neo.getSettings ───────────────────────────────────────────────────────

	describe('neo.getSettings', () => {
		it('returns securityMode and model from NeoAgentManager', async () => {
			const handler = hubData.handlers.get('neo.getSettings');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				securityMode: string;
				model: string;
			};
			expect(result.securityMode).toBe('balanced');
			expect(result.model).toBe('claude-opus-4-6');
		});
	});

	// ── neo.updateSettings ────────────────────────────────────────────────────

	describe('neo.updateSettings', () => {
		it('updates securityMode via SettingsManager', async () => {
			neoManager.getSecurityMode = mock(() => 'conservative' as const);
			const handler = hubData.handlers.get('neo.updateSettings');
			expect(handler).toBeDefined();

			const result = (await handler!({ securityMode: 'conservative' }, {})) as {
				success: boolean;
				securityMode: string;
			};
			expect(result.success).toBe(true);
			expect(settingsManager.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ neoSecurityMode: 'conservative' })
			);
		});

		it('updates model via SettingsManager', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await handler!({ model: 'claude-haiku-4-5' }, {});
			expect(settingsManager.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ neoModel: 'claude-haiku-4-5' })
			);
		});

		it('updates both securityMode and model together', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await handler!({ securityMode: 'autonomous', model: 'claude-sonnet-4-6' }, {});
			expect(settingsManager.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					neoSecurityMode: 'autonomous',
					neoModel: 'claude-sonnet-4-6',
				})
			);
		});

		it('throws for invalid securityMode', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await expect(handler!({ securityMode: 'super-safe' }, {})).rejects.toThrow(
				'Invalid securityMode'
			);
		});

		it('clears neoModel override when model is null', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await handler!({ model: null }, {});
			expect(settingsManager.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ neoModel: null })
			);
		});

		it('throws for empty model string', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await expect(handler!({ model: '   ' }, {})).rejects.toThrow(
				'model must be a non-empty string or null'
			);
		});

		it('throws when no updates provided', async () => {
			const handler = hubData.handlers.get('neo.updateSettings');
			await expect(handler!({}, {})).rejects.toThrow('At least one of');
		});
	});

	// ── neo.confirmAction ─────────────────────────────────────────────────────

	describe('neo.confirmAction', () => {
		it('executes stored action and injects result message', async () => {
			const actionId = store.store({
				toolName: 'create_room',
				input: { name: 'my-room' },
			});

			const handler = hubData.handlers.get('neo.confirmAction');
			expect(handler).toBeDefined();

			const result = (await handler!({ actionId }, {})) as {
				success: boolean;
				result?: { toolName: string };
			};
			expect(result.success).toBe(true);
			expect(result.result?.toolName).toBe('create_room');
			expect(sessionManager.injectMessage).toHaveBeenCalledTimes(1);
			const [, msg] = (sessionManager.injectMessage as ReturnType<typeof mock>).mock.calls[0];
			expect(msg).toContain('create_room');
		});

		it('removes action from store after confirm', async () => {
			const actionId = store.store({
				toolName: 'delete_room',
				input: { roomId: 'r1' },
			});
			const handler = hubData.handlers.get('neo.confirmAction');
			await handler!({ actionId }, {});
			// Re-confirm same actionId — should return not found
			const result2 = (await handler!({ actionId }, {})) as { success: boolean; error: string };
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('not found');
		});

		it('returns error for non-existent actionId', async () => {
			const handler = hubData.handlers.get('neo.confirmAction');
			const result = (await handler!({ actionId: 'nonexistent-uuid' }, {})) as {
				success: boolean;
				error: string;
			};
			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
		});

		it('throws when actionId is missing', async () => {
			const handler = hubData.handlers.get('neo.confirmAction');
			await expect(handler!({}, {})).rejects.toThrow('actionId is required');
		});

		it('returns error when injectMessage fails', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('inject failed');
			});

			const actionId = store.store({
				toolName: 'toggle_skill',
				input: { skillId: 's1' },
			});
			const handler = hubData.handlers.get('neo.confirmAction');
			const result = (await handler!({ actionId }, {})) as { success: boolean; error: string };
			expect(result.success).toBe(false);
			expect(result.error).toBe('inject failed');
		});
	});

	// ── neo.cancelAction ──────────────────────────────────────────────────────

	describe('neo.cancelAction', () => {
		it('removes action and injects cancellation message', async () => {
			const actionId = store.store({
				toolName: 'delete_space',
				input: { spaceId: 'sp1' },
			});

			const handler = hubData.handlers.get('neo.cancelAction');
			expect(handler).toBeDefined();

			const result = (await handler!({ actionId }, {})) as { success: boolean };
			expect(result.success).toBe(true);
			expect(sessionManager.injectMessage).toHaveBeenCalledTimes(1);
			const [, msg] = (sessionManager.injectMessage as ReturnType<typeof mock>).mock.calls[0];
			expect(msg).toContain('delete_space');
			expect(msg).toContain('cancelled');
		});

		it('succeeds even for non-existent actionId', async () => {
			const handler = hubData.handlers.get('neo.cancelAction');
			const result = (await handler!({ actionId: 'gone-already' }, {})) as { success: boolean };
			expect(result.success).toBe(true);
		});

		it('injects different message for expired/missing actions', async () => {
			const handler = hubData.handlers.get('neo.cancelAction');
			await handler!({ actionId: 'missing-id' }, {});
			const [, msg] = (sessionManager.injectMessage as ReturnType<typeof mock>).mock.calls[0];
			expect(msg).toContain('not found');
		});

		it('throws when actionId is missing', async () => {
			const handler = hubData.handlers.get('neo.cancelAction');
			await expect(handler!({}, {})).rejects.toThrow('actionId is required');
		});

		it('succeeds even if injectMessage fails (non-fatal)', async () => {
			sessionManager.injectMessage = mock(async () => {
				throw new Error('DB unavailable');
			});

			const actionId = store.store({
				toolName: 'stop_session',
				input: {},
			});
			const handler = hubData.handlers.get('neo.cancelAction');
			const result = (await handler!({ actionId }, {})) as { success: boolean };
			// Should succeed despite message injection failure
			expect(result.success).toBe(true);
		});
	});
});
