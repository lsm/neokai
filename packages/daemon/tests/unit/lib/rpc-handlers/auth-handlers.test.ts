/**
 * Auth Handlers Tests
 *
 * Tests for auth RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupAuthHandlers } from '../../../../src/lib/rpc-handlers/auth-handlers';
import type { MessageHub } from '@liuboer/shared';
import type { AuthManager } from '../../../../src/lib/auth-manager';

describe('Auth Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockAuthManager: AuthManager;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock AuthManager
		mockAuthManager = {
			getAuthStatus: mock(async () => ({
				isAuthenticated: true,
				method: 'api_key',
			})),
		} as unknown as AuthManager;

		// Setup handlers
		setupAuthHandlers(mockMessageHub, mockAuthManager);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register auth.status handler', () => {
			expect(handlers.has('auth.status')).toBe(true);
		});
	});

	describe('auth.status', () => {
		it('should return auth status', async () => {
			const result = await callHandler('auth.status', {});

			expect(result).toEqual({
				authStatus: {
					isAuthenticated: true,
					method: 'api_key',
				},
			});
			expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
		});

		it('should return unauthenticated status', async () => {
			(mockAuthManager.getAuthStatus as ReturnType<typeof mock>).mockResolvedValue({
				isAuthenticated: false,
				method: null,
			});

			const result = await callHandler('auth.status', {});

			expect(result).toEqual({
				authStatus: {
					isAuthenticated: false,
					method: null,
				},
			});
		});
	});
});
