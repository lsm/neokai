import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { InputTextarea } from '../InputTextarea';
import MentionAutocomplete from './MentionAutocomplete';

interface MentionAgent {
	id: string;
	name: string;
}

interface ThreadedChatComposerProps {
	mentionCandidates: MentionAgent[];
	hasTaskAgentSession: boolean;
	canSend: boolean;
	isSending: boolean;
	errorMessage?: string | null;
	onSend: (message: string) => Promise<boolean>;
}

export function ThreadedChatComposer({
	mentionCandidates,
	hasTaskAgentSession,
	canSend,
	isSending,
	errorMessage,
	onSend,
}: ThreadedChatComposerProps) {
	const [draft, setDraft] = useState('');
	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const lastCursorRef = useRef(0);

	const mentionAgents = useMemo(() => {
		if (mentionQuery === null) return [];
		return mentionCandidates.filter((agent) =>
			agent.name.toLowerCase().startsWith(mentionQuery.toLowerCase())
		);
	}, [mentionCandidates, mentionQuery]);

	const handleDraftChange = useCallback((value: string) => {
		const cursor = textareaRef.current?.selectionStart ?? value.length;
		lastCursorRef.current = cursor;
		setDraft(value);

		const textBeforeCursor = value.slice(0, cursor);
		const match = textBeforeCursor.match(/@(\w*)$/);
		if (match) {
			setMentionQuery(match[1]);
			setMentionSelectedIndex(0);
		} else {
			setMentionQuery(null);
		}
	}, []);

	const handleMentionSelect = useCallback(
		(name: string) => {
			if (!textareaRef.current) return;
			const textarea = textareaRef.current;
			const cursor = textarea.selectionStart ?? lastCursorRef.current;
			const textBeforeCursor = draft.slice(0, cursor);
			const textAfterCursor = draft.slice(cursor);
			const match = textBeforeCursor.match(/@(\w*)$/);
			if (!match) return;
			const start = cursor - match[0].length;
			const newValue = draft.slice(0, start) + '@' + name + ' ' + textAfterCursor;
			setDraft(newValue);
			setMentionQuery(null);
			setMentionSelectedIndex(0);
			setTimeout(() => {
				if (textareaRef.current) {
					const newCursor = start + name.length + 2;
					textareaRef.current.focus();
					textareaRef.current.setSelectionRange(newCursor, newCursor);
				}
			}, 0);
		},
		[draft]
	);

	const handleMentionClose = useCallback(() => {
		setMentionQuery(null);
		setMentionSelectedIndex(0);
	}, []);

	const submitDraft = useCallback(async () => {
		if (!canSend) return;
		const nextMessage = draft.trim();
		if (!nextMessage) return;
		const sent = await onSend(nextMessage);
		if (sent) {
			setDraft('');
			setMentionQuery(null);
			setMentionSelectedIndex(0);
		}
	}, [canSend, draft, onSend]);

	const handleFormSubmit = useCallback(
		(e: Event) => {
			e.preventDefault();
			void submitDraft();
		},
		[submitDraft]
	);

	return (
		<div class="px-1 pb-2" data-testid="threaded-chat-composer">
			{errorMessage && (
				<p class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
					{errorMessage}
				</p>
			)}
			<form onSubmit={handleFormSubmit}>
				<div class="relative">
					{mentionQuery !== null && mentionAgents.length > 0 && (
						<MentionAutocomplete
							agents={mentionAgents}
							selectedIndex={mentionSelectedIndex}
							onSelect={handleMentionSelect}
							onClose={handleMentionClose}
						/>
					)}
					<InputTextarea
						content={draft}
						onContentChange={handleDraftChange}
						onKeyDown={(e) => {
							if (mentionQuery !== null && mentionAgents.length > 0) {
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									setMentionSelectedIndex((i) => Math.min(i + 1, mentionAgents.length - 1));
									return;
								}
								if (e.key === 'ArrowUp') {
									e.preventDefault();
									setMentionSelectedIndex((i) => Math.max(i - 1, 0));
									return;
								}
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									if (mentionAgents[mentionSelectedIndex]) {
										handleMentionSelect(mentionAgents[mentionSelectedIndex].name);
									}
									return;
								}
								if (e.key === 'Escape') {
									e.preventDefault();
									handleMentionClose();
									return;
								}
							}
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								void submitDraft();
							}
						}}
						onSubmit={() => {
							void submitDraft();
						}}
						disabled={isSending}
						placeholder={
							hasTaskAgentSession ? 'Message task agent...' : 'Message task agent (auto-start)...'
						}
						textareaRef={textareaRef}
						transparent={true}
					/>
				</div>
			</form>
		</div>
	);
}
