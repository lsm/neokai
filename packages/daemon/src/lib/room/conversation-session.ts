/**
 * ConversationSessionWriter - Manages task conversation sessions
 *
 * A conversation session is a DB-only session (no AgentSession) that stores
 * all messages from Craft, Lead, Human, and System in a single timeline.
 * Room Runtime mirrors messages from agent sessions into this session.
 *
 * The frontend subscribes to it like any regular session and renders
 * messages with a custom turn-based renderer using the _taskMeta field.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';

export type AuthorRole = 'craft' | 'lead' | 'human' | 'system';

export interface TaskMeta {
	authorRole: AuthorRole;
	authorSessionId: string;
	turnId: string;
	iteration: number;
}

export class ConversationSessionWriter {
	constructor(
		private db: BunDatabase,
		private messageHub: MessageHub
	) {}

	/**
	 * Create the conversation session DB row.
	 * No AgentSession needed — this is a DB-only session for message storage.
	 */
	createSession(sessionId: string, roomId: string, taskId: string, workspacePath: string): void {
		const now = new Date().toISOString();
		const context = JSON.stringify({ roomId, taskId });

		this.db
			.prepare(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type, session_context)
			 VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 'task_conversation', ?)`
			)
			.run(sessionId, `Task Conversation`, workspacePath, now, now, context);
	}

	/**
	 * Mirror a message from a Craft/Lead session into the conversation session.
	 * Injects _taskMeta into the SDK message JSON blob for the frontend renderer.
	 */
	mirrorMessage(conversationSessionId: string, message: SDKMessage, meta: TaskMeta): void {
		const enrichedMessage = { ...message, _taskMeta: meta };
		const id = generateUUID();
		const messageType = message.type;
		const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
		const timestamp = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				conversationSessionId,
				messageType,
				messageSubtype,
				JSON.stringify(enrichedMessage),
				timestamp
			);

		// Broadcast delta to any subscribed frontends
		this.messageHub.event(
			'state.sdkMessages.delta',
			{ added: [{ ...enrichedMessage, timestamp: Date.now() }], timestamp: Date.now() },
			{ channel: `session:${conversationSessionId}` }
		);
	}

	/**
	 * Insert a system-level status message (turn transitions, pair state changes).
	 */
	insertStatusMessage(conversationSessionId: string, text: string, meta: TaskMeta): void {
		const statusMessage = {
			type: 'assistant' as const,
			uuid: generateUUID(),
			session_id: conversationSessionId,
			parent_tool_use_id: null,
			message: {
				role: 'assistant' as const,
				content: [{ type: 'text' as const, text }],
			},
			_taskMeta: { ...meta, authorRole: 'system' as AuthorRole },
		};

		const id = generateUUID();
		const timestamp = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(id, conversationSessionId, 'assistant', null, JSON.stringify(statusMessage), timestamp);

		this.messageHub.event(
			'state.sdkMessages.delta',
			{
				added: [{ ...statusMessage, timestamp: Date.now() }],
				timestamp: Date.now(),
			},
			{ channel: `session:${conversationSessionId}` }
		);
	}
}
