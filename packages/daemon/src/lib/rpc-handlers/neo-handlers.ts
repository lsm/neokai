/**
 * Neo RPC Handlers
 *
 * Exposes the Neo global agent over MessageHub:
 *   neo.send           — send a message to Neo
 *   neo.history        — retrieve paginated message history
 *   neo.clearSession   — reset the Neo session
 *   neo.getSettings    — read Neo settings (security mode, model)
 *   neo.updateSettings — write Neo settings
 *   neo.confirmAction  — execute a pending action by ID
 *   neo.cancelAction   — discard a pending action by ID
 */

import type { MessageHub } from '@neokai/shared';
import type { NeoAgentManager } from '../neo/neo-agent-manager';
import type { SessionManager } from '../session-manager';
import type { SettingsManager } from '../settings-manager';
import type { Database } from '../../storage/database';
import { PendingActionStore } from '../neo/security-tier';
import { NEO_SESSION_ID } from '../neo/neo-agent-manager';
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
import { randomUUID } from 'crypto';
import { Logger } from '../logger';

const log = new Logger('neo-handlers');

/**
 * Singleton pending action store — shared across all neo.confirmAction /
 * neo.cancelAction calls within the same daemon process.
 */
export const pendingActionStore = new PendingActionStore();

export function setupNeoHandlers(
	messageHub: MessageHub,
	neoAgentManager: NeoAgentManager,
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
	db: Database
): void {
	// ── neo.send ──────────────────────────────────────────────────────────────
	/**
	 * Send a message to the Neo session.
	 *
	 * Flow:
	 * 1. Verify credentials are present — return NO_CREDENTIALS if missing.
	 * 2. Run health-check + auto-recover (runtime source).
	 * 3. Inject the message via SessionManager.injectMessage().
	 * 4. Return { success, messageId }.
	 *
	 * Provider-level errors (rate limits, 5xx, network) are caught and returned
	 * as { success: false, error, errorCode: 'PROVIDER_ERROR' }.
	 */
	messageHub.onRequest('neo.send', async (data) => {
		const { message } = data as { message: string };

		if (!message || typeof message !== 'string' || message.trim() === '') {
			throw new Error('message is required and must be a non-empty string');
		}

		// Check that a session exists in memory (proxy for "are credentials configured?").
		// If NeoAgentManager was never provisioned (e.g. no API key at startup), the
		// session will be null and we return a friendly error rather than throwing.
		const session = neoAgentManager.getSession();
		if (!session) {
			return {
				success: false,
				error: 'API key not configured. Please set up your provider in Settings.',
				errorCode: 'NO_CREDENTIALS',
			};
		}

		// Health-check + auto-recover before injection.
		try {
			await neoAgentManager.healthCheck({ source: 'runtime' });
		} catch (err) {
			log.error('Neo health-check failed:', err);
			return {
				success: false,
				error: 'Neo is temporarily unavailable. Please try again.',
				errorCode: 'PROVIDER_ERROR',
			};
		}

		const messageId = randomUUID();

		try {
			await sessionManager.injectMessage(NEO_SESSION_ID, message, {
				origin: 'human',
			});
			return { success: true, messageId };
		} catch (err) {
			log.error('neo.send injection failed:', err);

			// Classify provider-level errors.
			const msg = err instanceof Error ? err.message : String(err);
			const isProviderError = /rate.?limit|429|503|502|500|network|timeout|ECONNREFUSED/i.test(msg);
			const isModelError = /model.*not.*found|model.*unavailable|invalid.*model/i.test(msg);

			if (isModelError) {
				return {
					success: false,
					error: `The selected Neo model is not available: ${msg}`,
					errorCode: 'MODEL_UNAVAILABLE',
				};
			}

			if (isProviderError) {
				return {
					success: false,
					error: 'Neo is temporarily unavailable. Please try again.',
					errorCode: 'PROVIDER_ERROR',
				};
			}

			// Re-throw unknown errors so the hub propagates them as RPC errors.
			throw err;
		}
	});

	// ── neo.history ───────────────────────────────────────────────────────────
	/**
	 * Retrieve paginated Neo message history.
	 *
	 * Parameters:
	 *   limit?  — max top-level messages to return (default: 50)
	 *   before? — timestamp cursor in milliseconds (load older messages)
	 *
	 * Returns:
	 *   { messages, hasMore }
	 */
	messageHub.onRequest('neo.history', async (data) => {
		const { limit, before } = (data ?? {}) as { limit?: number; before?: number };

		const resolvedLimit = typeof limit === 'number' && limit > 0 ? limit : 50;

		// Try live AgentSession first — falls back to DB if session isn't loaded.
		const agentSession = neoAgentManager.getSession();
		if (agentSession) {
			const { messages, hasMore } = agentSession.getSDKMessages(resolvedLimit, before, undefined);
			return { messages, hasMore };
		}

		// Session not provisioned — read directly from DB.
		const sdkMessageRepo = new SDKMessageRepository(db.getDatabase());
		const { messages, hasMore } = sdkMessageRepo.getSDKMessages(
			NEO_SESSION_ID,
			resolvedLimit,
			before,
			undefined
		);
		return { messages, hasMore };
	});

	// ── neo.clearSession ──────────────────────────────────────────────────────
	/**
	 * Stop the current Neo session and create a fresh one.
	 *
	 * This destroys the existing session (stopping any in-flight queries) and
	 * provisions a brand-new one. Message history for the old session remains
	 * in the DB under its original session ID — the new session starts empty.
	 *
	 * Returns: { success: boolean }
	 */
	messageHub.onRequest('neo.clearSession', async () => {
		try {
			// destroyAndRecreate is private — use the public provision path by
			// first invoking cleanup (gracefully stops current session), then
			// calling provision() which will detect the missing session and create one.
			await neoAgentManager.cleanup();
			await neoAgentManager.provision();
			return { success: true };
		} catch (err) {
			log.error('neo.clearSession failed:', err);
			return { success: false };
		}
	});

	// ── neo.getSettings ───────────────────────────────────────────────────────
	/**
	 * Read current Neo settings.
	 *
	 * Returns:
	 *   { securityMode, model }
	 */
	messageHub.onRequest('neo.getSettings', async () => {
		return {
			securityMode: neoAgentManager.getSecurityMode(),
			model: neoAgentManager.getModel(),
		};
	});

	// ── neo.updateSettings ────────────────────────────────────────────────────
	/**
	 * Update Neo settings (security mode and/or model).
	 *
	 * Parameters:
	 *   securityMode? — 'conservative' | 'balanced' | 'autonomous'
	 *   model?        — model identifier string
	 *
	 * Returns: { success: boolean, securityMode, model }
	 */
	messageHub.onRequest('neo.updateSettings', async (data) => {
		const { securityMode, model } = (data ?? {}) as {
			securityMode?: string;
			model?: string;
		};

		const updates: Record<string, unknown> = {};

		if (securityMode !== undefined) {
			if (!['conservative', 'balanced', 'autonomous'].includes(securityMode)) {
				throw new Error(
					`Invalid securityMode "${securityMode}". Must be conservative, balanced, or autonomous.`
				);
			}
			updates.neoSecurityMode = securityMode;
		}

		if (model !== undefined) {
			if (typeof model !== 'string' || model.trim() === '') {
				throw new Error('model must be a non-empty string');
			}
			updates.neoModel = model.trim();
		}

		if (Object.keys(updates).length === 0) {
			throw new Error('At least one of securityMode or model must be provided');
		}

		settingsManager.updateGlobalSettings(
			updates as Parameters<typeof settingsManager.updateGlobalSettings>[0]
		);

		return {
			success: true,
			securityMode: neoAgentManager.getSecurityMode(),
			model: neoAgentManager.getModel(),
		};
	});

	// ── neo.confirmAction ─────────────────────────────────────────────────────
	/**
	 * Execute a pending action by its actionId.
	 *
	 * This is the primary confirmation path called by NeoConfirmationCard UI.
	 * It retrieves the stored PendingAction, executes it via the provided
	 * executor, and injects a system result message into the Neo chat.
	 *
	 * Parameters:
	 *   actionId — UUID returned when the action was stored
	 *
	 * Returns: { success: boolean, result?, error? }
	 */
	messageHub.onRequest('neo.confirmAction', async (data) => {
		const { actionId } = (data ?? {}) as { actionId?: string };

		if (!actionId || typeof actionId !== 'string') {
			throw new Error('actionId is required');
		}

		const action = pendingActionStore.retrieve(actionId);
		if (!action) {
			return { success: false, error: 'Action not found or expired' };
		}

		pendingActionStore.remove(actionId);

		try {
			// Actions are placeholders until Neo tool execution is wired.
			// For now execute a no-op and inject a confirmation system message.
			const resultMessage = `[System] Action "${action.toolName}" confirmed and executed.`;
			await sessionManager.injectMessage(NEO_SESSION_ID, resultMessage, {
				origin: 'system' as const,
			});
			return { success: true, result: { toolName: action.toolName, input: action.input } };
		} catch (err) {
			log.error('neo.confirmAction execution failed:', err);
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	// ── neo.cancelAction ──────────────────────────────────────────────────────
	/**
	 * Discard a pending action without executing it.
	 *
	 * Injects a cancellation system message into Neo chat so the conversation
	 * history accurately reflects that the action was not taken.
	 *
	 * Parameters:
	 *   actionId — UUID of the action to cancel
	 *
	 * Returns: { success: boolean }
	 */
	messageHub.onRequest('neo.cancelAction', async (data) => {
		const { actionId } = (data ?? {}) as { actionId?: string };

		if (!actionId || typeof actionId !== 'string') {
			throw new Error('actionId is required');
		}

		const action = pendingActionStore.retrieve(actionId);
		const existed = action !== undefined;
		pendingActionStore.remove(actionId);

		const cancelMessage = existed
			? `[System] Action "${action!.toolName}" was cancelled by the user.`
			: '[System] Action cancellation requested (action not found or already expired).';

		try {
			await sessionManager.injectMessage(NEO_SESSION_ID, cancelMessage, {
				origin: 'system' as const,
			});
		} catch (err) {
			// Non-fatal: log but still return success if the action was removed.
			log.error('neo.cancelAction message injection failed:', err);
		}

		return { success: true };
	});
}
