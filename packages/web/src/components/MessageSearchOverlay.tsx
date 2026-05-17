import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { navigateToSession, navigateToSpaceTask } from '../lib/router.ts';
import { searchHighlightMessageIdSignal } from '../lib/signals.ts';
import { toast } from '../lib/toast.ts';
import { Button } from './ui/Button.tsx';
import { Modal } from './ui/Modal.tsx';

export interface MessageSearchResult {
	kind: 'message' | 'task';
	sourceId: string;
	messageId?: string;
	sessionId?: string;
	taskId?: string;
	spaceId?: string;
	taskNumber?: number;
	messageType?: string;
	title: string;
	snippet: string;
	timestamp: number;
	loadTarget?: MessageSearchLoadTarget;
	rank: number;
}

interface MessageSearchLoadTarget {
	sessionId: string;
	before?: number;
}

interface MessageSearchResponse {
	results: MessageSearchResult[];
	limit: number;
	offset: number;
}

interface MessageSearchOverlayProps {
	isOpen: boolean;
	onClose: () => void;
	currentSessionId: string;
	onSelectMessage: (messageId: string, loadTarget?: MessageSearchLoadTarget) => void;
}

export function MessageSearchOverlay({
	isOpen,
	onClose,
	currentSessionId,
	onSelectMessage,
}: MessageSearchOverlayProps) {
	const [query, setQuery] = useState('');
	const [searchAll, setSearchAll] = useState(false);
	const [loading, setLoading] = useState(false);
	const [results, setResults] = useState<MessageSearchResult[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		if (!isOpen) return;
		setTimeout(() => inputRef.current?.focus(), 0);
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) return;
		const trimmed = query.trim();
		const requestId = ++requestIdRef.current;
		if (!trimmed) {
			setLoading(false);
			setResults([]);
			return;
		}

		const timeout = setTimeout(async () => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				toast.error('Connection lost.');
				return;
			}
			try {
				setLoading(true);
				const response = await hub.request<MessageSearchResponse>('message.search', {
					query: trimmed,
					sessionId: searchAll ? undefined : currentSessionId,
					limit: 25,
				});
				if (requestId === requestIdRef.current) {
					setResults(response.results);
				}
			} catch (error) {
				if (requestId === requestIdRef.current) {
					toast.error(error instanceof Error ? error.message : 'Search failed');
				}
			} finally {
				if (requestId === requestIdRef.current) {
					setLoading(false);
				}
			}
		}, 250);

		return () => clearTimeout(timeout);
	}, [isOpen, query, searchAll, currentSessionId]);

	const selectResult = useCallback(
		(result: MessageSearchResult) => {
			if (result.kind === 'task' && result.spaceId && result.taskId) {
				navigateToSpaceTask(result.spaceId, result.taskId, 'thread');
				onClose();
				return;
			}
			if (!result.sessionId) return;
			const targetMessageId = result.messageId || result.sourceId;
			if (result.sessionId !== currentSessionId) {
				searchHighlightMessageIdSignal.value = {
					sessionId: result.sessionId,
					messageId: targetMessageId,
					loadTarget: result.loadTarget,
				};
				navigateToSession(result.sessionId);
			} else {
				onSelectMessage(targetMessageId, result.loadTarget);
			}
			onClose();
		},
		[currentSessionId, onClose, onSelectMessage]
	);

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Search messages" size="lg">
			<div class="space-y-4">
				<div class="flex gap-2">
					<input
						ref={inputRef}
						type="search"
						value={query}
						onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
						placeholder={searchAll ? 'Search all sessions and tasks…' : 'Search this session…'}
						class="flex-1 rounded-lg border border-dark-700 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
					/>
					<Button
						variant={searchAll ? 'primary' : 'secondary'}
						onClick={() => setSearchAll((v) => !v)}
					>
						{searchAll ? 'All' : 'This chat'}
					</Button>
				</div>

				<div class="max-h-[55vh] overflow-y-auto rounded-lg border border-dark-700 bg-dark-900/50">
					{loading && <div class="px-4 py-6 text-sm text-gray-400">Searching…</div>}
					{!loading && query.trim() && results.length === 0 && (
						<div class="px-4 py-6 text-sm text-gray-400">No matches</div>
					)}
					{!query.trim() && (
						<div class="px-4 py-6 text-sm text-gray-500">
							Type keyword to search message text, thinking, results, and Space tasks.
						</div>
					)}
					{results.map((result) => (
						<SearchResultButton
							key={`${result.kind}:${result.sourceId}`}
							result={result}
							onSelect={selectResult}
						/>
					))}
				</div>
			</div>
		</Modal>
	);
}

function SearchResultButton({
	result,
	onSelect,
}: {
	result: MessageSearchResult;
	onSelect: (result: MessageSearchResult) => void;
}) {
	const snippetParts = useMemo(() => splitHighlightedSnippet(result.snippet), [result.snippet]);
	return (
		<button
			type="button"
			onClick={() => onSelect(result)}
			class="block w-full border-b border-dark-800 px-4 py-3 text-left hover:bg-dark-800 focus:bg-dark-800 focus:outline-none last:border-b-0"
		>
			<div class="mb-1 flex items-center gap-2 text-xs text-gray-500">
				<span class="rounded bg-dark-700 px-1.5 py-0.5 uppercase text-gray-300">{result.kind}</span>
				{result.messageType && <span>{result.messageType}</span>}
				{result.taskNumber && <span>Task #{result.taskNumber}</span>}
			</div>
			<div class="truncate text-sm font-medium text-gray-100">{result.title}</div>
			<div class="mt-1 line-clamp-2 text-sm text-gray-400">
				{snippetParts.map((part, index) =>
					part.highlight ? (
						<mark
							// biome-ignore lint/suspicious/noArrayIndexKey: Stable text split from snippet string.
							key={index}
							class="rounded bg-amber-400/30 px-0.5 text-amber-100"
						>
							{part.text}
						</mark>
					) : (
						<span // biome-ignore lint/suspicious/noArrayIndexKey: Stable text split from snippet string.
							key={index}
						>
							{part.text}
						</span>
					)
				)}
			</div>
		</button>
	);
}

function splitHighlightedSnippet(snippet: string): Array<{ text: string; highlight: boolean }> {
	const parts: Array<{ text: string; highlight: boolean }> = [];
	const tokens = snippet.split(/(<mark>|<\/mark>)/g);
	let highlight = false;
	for (const token of tokens) {
		if (token === '<mark>') {
			highlight = true;
			continue;
		}
		if (token === '</mark>') {
			highlight = false;
			continue;
		}
		if (token) parts.push({ text: token, highlight });
	}
	return parts;
}
