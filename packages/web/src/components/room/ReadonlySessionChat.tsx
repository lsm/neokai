/**
 * ReadonlySessionChat
 *
 * Independently fetches and renders messages for a given sessionId without
 * touching sessionStore. Used by SlideOutPanel to display a secondary session's
 * chat without overwriting the primary session's data.
 *
 * Data loading:
 * - Joins channel `session:${sessionId}` and subscribes to `state.sdkMessages.delta`
 * - Initial fetch via `state.sdkMessages` RPC (stale-fetch guarded by cancelled flag)
 * - Pagination via `message.sdkMessages` RPC (numeric `before` timestamp)
 * - Deduplicates by UUID on delta events (Safari reconnect replay guard)
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';

type SDKMessageWithTimestamp = SDKMessage & { timestamp: number };

interface Props {
	sessionId: string;
}

const LOAD_OLDER_LIMIT = 100;

export function ReadonlySessionChat({ sessionId }: Props) {
	const { request, onEvent, joinRoom, leaveRoom, isConnected } = useMessageHub();

	const [messages, setMessages] = useState<SDKMessageWithTimestamp[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const [isLoadingOlder, setIsLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [paginationError, setPaginationError] = useState<string | null>(null);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const didScrollRef = useRef(false);

	// Channel subscription + delta events — gated on isConnected (see useGroupMessages pattern)
	useEffect(() => {
		if (!sessionId || !isConnected) return;

		const channel = `session:${sessionId}`;
		joinRoom(channel);

		const unsubDelta = onEvent<{ added?: SDKMessage[] }>(
			'state.sdkMessages.delta',
			(data, context) => {
				// Filter by channel to avoid cross-session bleed
				if ((context as { channel?: string }).channel !== channel) return;
				if (!data.added?.length) return;

				setMessages((prev) => {
					const existingIds = new Set(prev.map((m) => m.uuid));
					const newMessages = (data.added as SDKMessageWithTimestamp[]).filter(
						(m) => !existingIds.has(m.uuid)
					);
					if (newMessages.length === 0) return prev;
					return [...prev, ...newMessages];
				});
			}
		);

		return () => {
			unsubDelta();
			leaveRoom(channel);
		};
	}, [sessionId, isConnected, onEvent, joinRoom, leaveRoom]);

	// Initial fetch — re-runs when sessionId or isConnected changes.
	// Uses a cancelled flag to discard stale responses when sessionId changes
	// or the component unmounts before the request resolves.
	useEffect(() => {
		if (!sessionId || !isConnected) return;

		let cancelled = false;
		setIsLoading(true);
		setError(null);
		setMessages([]);
		setHasMore(false);
		didScrollRef.current = false;

		request<{ sdkMessages: SDKMessage[]; hasMore: boolean }>('state.sdkMessages', { sessionId })
			.then((result) => {
				if (cancelled) return;
				setMessages((result?.sdkMessages ?? []) as SDKMessageWithTimestamp[]);
				setHasMore(result?.hasMore ?? false);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : 'Failed to load messages');
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [sessionId, isConnected, request]);

	// Auto-scroll to bottom when new messages arrive
	useEffect(() => {
		if (messages.length > 0 && messagesEndRef.current) {
			messagesEndRef.current.scrollIntoView({ behavior: didScrollRef.current ? 'smooth' : 'auto' });
			didScrollRef.current = true;
		}
	}, [messages.length]);

	const loadOlderMessages = async () => {
		if (isLoadingOlder || !hasMore || messages.length === 0) return;

		// Find oldest timestamp — the repository-injected numeric ms field
		const oldest = messages[0];
		const oldestTimestamp = oldest.timestamp;
		if (!oldestTimestamp) return;

		setIsLoadingOlder(true);
		setPaginationError(null);
		try {
			const result = await request<{ sdkMessages: SDKMessage[]; hasMore: boolean }>(
				'message.sdkMessages',
				{ sessionId, before: oldestTimestamp, limit: LOAD_OLDER_LIMIT }
			);
			const older = (result?.sdkMessages ?? []) as SDKMessageWithTimestamp[];
			setHasMore(result?.hasMore ?? false);
			if (older.length > 0) {
				setMessages((prev) => {
					const existingIds = new Set(prev.map((m) => m.uuid));
					const deduped = older.filter((m) => !existingIds.has(m.uuid));
					return [...deduped, ...prev];
				});
			}
		} catch (err: unknown) {
			setPaginationError(err instanceof Error ? err.message : 'Failed to load older messages');
		} finally {
			setIsLoadingOlder(false);
		}
	};

	const maps = useMessageMaps(messages, sessionId);

	return (
		<div data-testid="readonly-session-chat" class="flex flex-col h-full overflow-hidden">
			{/* Load older button */}
			{hasMore && (
				<div class="flex-shrink-0 p-2 border-b border-gray-700">
					<button
						onClick={loadOlderMessages}
						disabled={isLoadingOlder}
						class="w-full text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50 py-1"
					>
						{isLoadingOlder ? 'Loading…' : 'Load older messages'}
					</button>
					{paginationError && (
						<div class="text-xs text-red-400 text-center mt-1">{paginationError}</div>
					)}
				</div>
			)}

			{/* Messages area */}
			<div class="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
				{isLoading && (
					<div class="flex items-center justify-center py-8 text-gray-500 text-sm">
						Loading messages…
					</div>
				)}

				{!isLoading && error && (
					<div class="flex items-center justify-center py-8 text-red-400 text-sm">{error}</div>
				)}

				{!isLoading && !error && messages.length === 0 && (
					<div class="flex items-center justify-center py-8 text-gray-500 text-sm">
						No messages yet
					</div>
				)}

				{messages.map((msg) => (
					<SDKMessageRenderer
						key={msg.uuid}
						message={msg}
						sessionId={sessionId}
						toolResultsMap={maps.toolResultsMap}
						toolInputsMap={maps.toolInputsMap}
						subagentMessagesMap={maps.subagentMessagesMap}
						sessionInfo={maps.sessionInfoMap.get(msg.uuid ?? '')}
						taskContext={false}
					/>
				))}

				<div ref={messagesEndRef} />
			</div>
		</div>
	);
}
