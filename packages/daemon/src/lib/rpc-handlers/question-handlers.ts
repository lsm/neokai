/**
 * Question RPC Handlers
 *
 * Handles user responses to AskUserQuestion tool calls.
 */

import type { MessageHub, QuestionDraftResponse } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionManager } from '../session-manager';

/**
 * Payload for question.respond RPC call
 */
interface QuestionRespondPayload {
	sessionId: string;
	toolUseId: string;
	responses: QuestionDraftResponse[];
}

/**
 * Payload for question.saveDraft RPC call
 */
interface QuestionSaveDraftPayload {
	sessionId: string;
	draftResponses: QuestionDraftResponse[];
}

/**
 * Payload for question.cancel RPC call
 */
interface QuestionCancelPayload {
	sessionId: string;
	toolUseId: string;
}

export function setupQuestionHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	_daemonHub: DaemonHub
): void {
	/**
	 * question.respond - Send user's response to pending question
	 *
	 * This sends the user's selected options as a tool_result message
	 * to continue the SDK query that was paused waiting for input.
	 */
	messageHub.onQuery('question.respond', async (data) => {
		const { sessionId, toolUseId, responses } = data as QuestionRespondPayload;

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		await agentSession.handleQuestionResponse(toolUseId, responses);
		return { success: true };
	});

	/**
	 * question.saveDraft - Save draft responses as user interacts (before submit)
	 *
	 * This allows preserving the user's partial selections if they
	 * navigate away or refresh the page before submitting.
	 */
	messageHub.onQuery('question.saveDraft', async (data) => {
		const { sessionId, draftResponses } = data as QuestionSaveDraftPayload;

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		await agentSession.updateQuestionDraft(draftResponses);
		return { success: true };
	});

	/**
	 * question.cancel - Cancel the pending question without answering
	 *
	 * This allows the user to dismiss the question. The agent will receive
	 * a message indicating the user cancelled, and can decide how to proceed.
	 */
	messageHub.onQuery('question.cancel', async (data) => {
		const { sessionId, toolUseId } = data as QuestionCancelPayload;

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		await agentSession.handleQuestionCancel(toolUseId);
		return { success: true };
	});
}
