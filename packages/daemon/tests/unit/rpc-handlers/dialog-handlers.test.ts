/**
 * Tests for Dialog RPC Handlers
 *
 * Tests the RPC handlers for native OS dialogs:
 * - dialog.pickFolder - Open native folder picker dialog
 *
 * Since dialog handlers interact with OS-specific commands (osascript, zenity, PowerShell),
 * these tests mock the platform and command execution to test the logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupDialogHandlers } from '../../../src/lib/rpc-handlers/dialog-handlers';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
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

describe('Dialog RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let originalPlatform: string;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		originalPlatform = process.platform;

		// Setup handlers
		setupDialogHandlers(messageHubData.hub);
	});

	afterEach(() => {
		// Restore platform
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
			configurable: true,
		});
		mock.restore();
	});

	describe('dialog.pickFolder', () => {
		it('registers the handler', () => {
			const handler = messageHubData.handlers.get('dialog.pickFolder');
			expect(handler).toBeDefined();
		});

		it('handler is an async function', () => {
			const handler = messageHubData.handlers.get('dialog.pickFolder');
			expect(handler).toBeDefined();
			expect(typeof handler).toBe('function');
			// Handler should return a promise
			const result = handler!({}, {});
			expect(result).toBeInstanceOf(Promise);
		});
	});
});
