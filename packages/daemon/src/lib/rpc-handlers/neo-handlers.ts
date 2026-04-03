/**
 * Neo RPC Handlers
 *
 * Exposes the Neo global agent over MessageHub:
 *   neo.send           — send a message to Neo
 *   neo.history        — retrieve paginated message history
 *   neo.clearSession   — reset the Neo session
 *   neo.isProvisioned  — check if Neo credentials are configured (no LLM call)
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
import { Logger } from '../logger';

const log = new Logger('neo-handlers');

export function setupNeoHandlers(
	messageHub: MessageHub,
	neoAgentManager: NeoAgentManager,
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
	db: Database,
	/**
	 * Pending action store. Defaults to a new instance if not provided.
	 * Accept as a parameter so callers (and tests) can inject their own store.
	 */
	pendingActions: PendingActionStore = new PendingActionStore()
): void {
	// ── neo.send ──────────────────────────────────────────────────────────────
	/**
	 * Send a message to the Neo session.
	 *
	 * Flow:
	 * 1. Verify session exists — return NO_CREDENTIALS if not provisioned.
	 * 2. Run health-check + auto-recover (runtime source).
	 * 3. Inject the message via SessionManager.injectMessage().
	 * 4. Return { success: true }.
	 *
	 * Provider-level errors (rate limits, 5xx, network) are caught and returned
	 * as { success: false, error, errorCode: 'PROVIDER_ERROR' }.
	 *
	 * Note: no messageId is returned because SessionManager.injectMessage()
	 * returns void — the persisted message ID is not available to this layer.
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

		try {
			await sessionManager.injectMessage(NEO_SESSION_ID, message, {
				origin: 'human',
			});
			return { success: true };
		} catch (err) {
			log.error('neo.send injection failed:', err);

			// Classify provider-level errors by message patterns.
			// These cover the most common cases across Anthropic, GLM, and Copilot
			// providers. Unknown errors are re-thrown so callers get the raw RPC error.
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
	 * Delegates to NeoAgentManager.clearSession() which wraps destroyAndRecreate().
	 * The operation is atomic: if re-creation fails the error propagates and the
	 * response includes the error message so callers can surface it to the user.
	 * Message history for the old session remains in the DB.
	 *
	 * Returns: { success: boolean, error?: string }
	 */
	messageHub.onRequest('neo.clearSession', async () => {
		try {
			await neoAgentManager.clearSession();
			return { success: true };
		} catch (err) {
			log.error('neo.clearSession failed:', err);
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	// ── neo.isProvisioned ─────────────────────────────────────────────────────
	/**
	 * Check whether the Neo session is provisioned AND the LLM is expected to respond.
	 *
	 * This is a lightweight, synchronous check — no LLM call is made.
	 * Returns { provisioned: boolean }.
	 *
	 * Two conditions must hold:
	 * 1. `neoAgentManager.getSession() !== null` — the session was provisioned
	 *    (a DB record exists and the session is held in memory).
	 * 2. `NEOKAI_NEO_LLM_AVAILABLE !== '0'` — the LLM backend is expected to be
	 *    reachable. Set `NEOKAI_NEO_LLM_AVAILABLE=0` in environments where the
	 *    session can be provisioned (e.g., a dummy API key satisfies isAvailable())
	 *    but the LLM will never respond (e.g., no-LLM CI with a devproxy test key).
	 *
	 * Session existence alone is NOT a reliable proxy for credential validity:
	 * `provision()` succeeds whenever any API key is present, even a dummy one.
	 * The env var provides an explicit opt-out for no-LLM CI environments where
	 * a dummy key is used to satisfy availability checks for non-Neo tests.
	 *
	 * Used by E2E tests in `beforeEach` to skip AI-dependent scenarios without
	 * waiting 90 s for an LLM response that will never arrive.
	 */
	messageHub.onRequest('neo.isProvisioned', () => {
		const sessionExists = neoAgentManager.getSession() !== null;
		const llmAvailable = process.env.NEOKAI_NEO_LLM_AVAILABLE !== '0';
		return { provisioned: sessionExists && llmAvailable };
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
			model?: string | null;
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
			if (model === null) {
				// null clears the override — Neo falls back to the app's primary model
				updates.neoModel = null;
			} else if (typeof model !== 'string' || model.trim() === '') {
				throw new Error('model must be a non-empty string or null');
			} else {
				updates.neoModel = model.trim();
			}
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
	 * It retrieves the stored PendingAction, executes it, and injects a system
	 * result message into the Neo chat.
	 *
	 * TODO: wire actual tool execution once Neo tool registry is implemented
	 * (task M3 action tools). Currently performs a no-op placeholder.
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

		const action = pendingActions.retrieve(actionId);
		if (!action) {
			return { success: false, error: 'Action not found or expired' };
		}

		pendingActions.remove(actionId);

		try {
			const resultMessage = `[System] Action "${action.toolName}" confirmed and executed.`;
			await sessionManager.injectMessage(NEO_SESSION_ID, resultMessage, {
				origin: 'system',
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

		const action = pendingActions.retrieve(actionId);
		pendingActions.remove(actionId);

		const cancelMessage =
			action !== undefined
				? `[System] Action "${action.toolName}" was cancelled by the user.`
				: '[System] Action cancellation requested (action not found or already expired).';

		try {
			await sessionManager.injectMessage(NEO_SESSION_ID, cancelMessage, {
				origin: 'system',
			});
		} catch (err) {
			// Non-fatal: log but still return success if the action was removed.
			log.error('neo.cancelAction message injection failed:', err);
		}

		return { success: true };
	});
}
