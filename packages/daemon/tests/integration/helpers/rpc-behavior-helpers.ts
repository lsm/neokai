/**
 * RPC Behavior Helpers
 *
 * Simplified helpers for behavior-driven integration testing.
 * These wrap callRPCHandler with domain-specific semantics.
 */

import type { MessageHub, Session } from '@liuboer/shared';
import { callRPCHandler } from '../../test-utils';

/**
 * Create a session via RPC and return session ID
 */
export async function createSession(
	messageHub: MessageHub,
	params: {
		workspacePath: string;
		title?: string;
		config?: Record<string, unknown>;
	}
): Promise<string> {
	const result = await callRPCHandler(messageHub, 'session.create', params);
	return result.sessionId as string;
}

/**
 * Get session details via RPC
 */
export async function getSession(messageHub: MessageHub, sessionId: string): Promise<Session> {
	const result = await callRPCHandler(messageHub, 'session.get', { sessionId });
	return result.session as Session;
}

/**
 * Update session via RPC
 */
export async function updateSession(
	messageHub: MessageHub,
	sessionId: string,
	updates: {
		title?: string;
		config?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}
): Promise<void> {
	await callRPCHandler(messageHub, 'session.update', { sessionId, ...updates });
}

/**
 * Delete session via RPC
 */
export async function deleteSession(messageHub: MessageHub, sessionId: string): Promise<void> {
	await callRPCHandler(messageHub, 'session.delete', { sessionId });
}

/**
 * List all sessions via RPC
 */
export async function listSessions(messageHub: MessageHub, filter?: string): Promise<Session[]> {
	const result = await callRPCHandler(messageHub, 'session.list', filter ? { filter } : {});
	return result.sessions as Session[];
}

/**
 * Get SDK messages for a session via RPC
 */
export async function getSDKMessages(
	messageHub: MessageHub,
	sessionId: string,
	options?: { limit?: number; offset?: number }
): Promise<unknown[]> {
	const result = await callRPCHandler(messageHub, 'message.sdkMessages', {
		sessionId,
		...options,
	});
	return result.sdkMessages as unknown[];
}

/**
 * Send a message to a session via RPC (for offline tests, returns message ID only)
 */
export async function sendMessage(
	messageHub: MessageHub,
	sessionId: string,
	content: string
): Promise<string> {
	const result = await callRPCHandler(messageHub, 'message.send', {
		sessionId,
		message: content,
	});
	return result.messageId as string;
}

/**
 * Get processing state for a session via RPC
 */
export async function getProcessingState(
	messageHub: MessageHub,
	sessionId: string
): Promise<{ status: string; phase?: string }> {
	const result = await callRPCHandler(messageHub, 'session.get', { sessionId });
	return {
		status: (result.context as { processingState: { status: string } }).processingState.status,
		phase: (result.context as { processingState: { phase?: string } }).processingState.phase,
	};
}
