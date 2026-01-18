/**
 * Test helper for sending messages synchronously in tests
 *
 * ARCHITECTURE: Uses DaemonHub pattern to replicate production flow
 * Production code: RPC → emit message.sendRequest → SessionManager persists → emit message.persisted → AgentSession processes
 *
 * Tests need synchronous await pattern, so we:
 * 1. Wait for message.persisted event to complete persistence
 * 2. Wait for message to be enqueued to SDK queue
 */

import type { AgentSession } from '../../src/lib/agent';
import type { MessageImage, MessageContent } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

/**
 * Send a message and wait for it to be enqueued to the SDK
 *
 * This is the test-only equivalent of the production message flow:
 * 1. Emit message:send:request event (SessionManager handles persistence)
 * 2. Wait for message:persisted event (AgentSession starts query)
 * 3. Wait for message to be enqueued to SDK
 */
export async function sendMessageSync(
	agentSession: AgentSession,
	data: { content: string; images?: MessageImage[] }
): Promise<{ messageId: string }> {
	// Access private members via type assertion (test-only pattern)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const session = agentSession as any;

	const messageId = generateUUID();

	// Create a promise that resolves when message is enqueued
	let resolveEnqueue: (() => void) | null = null;
	const enqueuePromise = new Promise<void>((resolve) => {
		resolveEnqueue = resolve;
	});

	// Subscribe to message queue to detect when our message is enqueued
	const originalEnqueue = session.messageQueue.enqueueWithId.bind(session.messageQueue);
	session.messageQueue.enqueueWithId = async (id: string, content: string | MessageContent[]) => {
		await originalEnqueue(id, content);
		if (id === messageId && resolveEnqueue) {
			resolveEnqueue();
		}
	};

	// Emit message.sendRequest event (same as production RPC handler)
	// SessionManager will persist and emit message.persisted
	// AgentSession will start query and enqueue message
	await session.daemonHub.emit('message.sendRequest', {
		sessionId: session.session.id,
		messageId,
		content: data.content,
		images: data.images,
	});

	// Wait for message to be enqueued
	await enqueuePromise;

	// Restore original enqueue method
	session.messageQueue.enqueueWithId = originalEnqueue;

	return { messageId };
}
