/**
 * GroupMessage — a row from the session_group_messages table as returned by
 * the `sessionGroupMessages.byGroup` LiveQuery named query (and the
 * `task.getGroupMessages` RPC for backward compatibility).
 *
 * Column names are camelCased via SQL aliasing in the named-query registry.
 */
export interface GroupMessage {
	id: number;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
	createdAt: number;
}
