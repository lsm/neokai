/**
 * SDK Message Renderer - Routes SDK messages to appropriate renderers
 */

import type { JSX } from 'preact';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { PendingUserQuestion, QuestionDraftResponse, ResolvedQuestion } from '@neokai/shared';
import {
	isSDKAssistantMessage,
	isSDKResultMessage,
	isSDKSystemMessage,
	isSDKSystemInit,
	isSDKToolProgressMessage,
	isSDKAuthStatusMessage,
	isSDKUserMessage,
	isSDKUserMessageReplay,
	isUserVisibleMessage,
} from '@neokai/shared/sdk/type-guards';

// Component imports
import { SDKAssistantMessage } from './SDKAssistantMessage.tsx';
import { SDKResultMessage } from './SDKResultMessage.tsx';
import { SDKSystemMessage } from './SDKSystemMessage.tsx';
import { SDKToolProgressMessage } from './SDKToolProgressMessage.tsx';
import { SDKUserMessage } from './SDKUserMessage.tsx';
import { AuthStatusCard } from './tools/index.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
	message: SDKMessage;
	toolResultsMap?: Map<string, unknown>;
	toolInputsMap?: Map<string, unknown>;
	subagentMessagesMap?: Map<string, SDKMessage[]>;
	sessionInfo?: SystemInitMessage; // Optional session init info to attach to user messages
	// Question handling props for inline QuestionPrompt rendering
	sessionId?: string;
	resolvedQuestions?: Map<string, ResolvedQuestion>;
	pendingQuestion?: PendingUserQuestion | null;
	onQuestionResolved?: (
		state: 'submitted' | 'cancelled',
		responses: QuestionDraftResponse[]
	) => void;
	onRewind?: (uuid: string) => void; // Rewind to this message
	rewindingMessageUuid?: string | null; // UUID of message currently being rewound (shows spinner)
	// Rewind mode props
	rewindMode?: boolean;
	selectedMessages?: Set<string>;
	onMessageCheckboxChange?: (messageId: string, checked: boolean) => void;
	allMessages?: SDKMessage[];
}

/**
 * Check if message is a sub-agent message (has parent_tool_use_id)
 * Sub-agent messages are shown inside SubagentBlock, not as separate messages
 */
function isSubagentMessage(message: SDKMessage): boolean {
	const msgWithParent = message as SDKMessage & {
		parent_tool_use_id?: string | null;
	};
	return !!msgWithParent.parent_tool_use_id;
}

/**
 * Main SDK message renderer - routes to appropriate sub-renderer
 */
export function SDKMessageRenderer({
	message,
	toolResultsMap,
	toolInputsMap,
	subagentMessagesMap,
	sessionInfo,
	sessionId,
	resolvedQuestions,
	pendingQuestion,
	onQuestionResolved,
	onRewind,
	rewindingMessageUuid,
	rewindMode,
	selectedMessages,
	onMessageCheckboxChange,
	allMessages: _allMessages,
}: Props) {
	// Skip messages that shouldn't be shown to user (e.g., stream events)
	if (!isUserVisibleMessage(message)) {
		return null;
	}

	// Skip session init messages - they're now shown as indicators attached to user messages
	if (isSDKSystemInit(message)) {
		return null;
	}

	// Skip sub-agent messages - they're now shown inside SubagentBlock
	if (isSubagentMessage(message)) {
		return null;
	}

	// Compute the rendered message component without passing rewind props to child components
	let renderedMessage: JSX.Element | null = null;

	// Route to appropriate renderer based on message type
	// Handle user replay messages (slash command responses) first
	if (isSDKUserMessageReplay(message)) {
		renderedMessage = (
			<SDKUserMessage
				message={message}
				sessionInfo={sessionInfo}
				isReplay={true}
				sessionId={sessionId}
			/>
		);
	} else if (isSDKUserMessage(message)) {
		renderedMessage = (
			<SDKUserMessage message={message} sessionInfo={sessionInfo} sessionId={sessionId} />
		);
	} else if (isSDKAssistantMessage(message)) {
		renderedMessage = (
			<SDKAssistantMessage
				message={message}
				toolResultsMap={toolResultsMap}
				subagentMessagesMap={subagentMessagesMap}
				sessionId={sessionId}
				resolvedQuestions={resolvedQuestions}
				pendingQuestion={pendingQuestion}
				onQuestionResolved={onQuestionResolved}
			/>
		);
	} else if (isSDKResultMessage(message)) {
		renderedMessage = <SDKResultMessage message={message} />;
	} else if (isSDKSystemMessage(message)) {
		renderedMessage = <SDKSystemMessage message={message} />;
	} else if (isSDKToolProgressMessage(message)) {
		const toolInput = toolInputsMap?.get(message.tool_use_id);
		renderedMessage = <SDKToolProgressMessage message={message} toolInput={toolInput} />;
	} else if (isSDKAuthStatusMessage(message)) {
		renderedMessage = (
			<AuthStatusCard
				isAuthenticating={message.isAuthenticating}
				output={message.output}
				error={message.error}
				variant="default"
			/>
		);
	} else {
		// Fallback for unknown message types (shouldn't happen, but safe)
		renderedMessage = (
			<div class="p-3 bg-gray-100 dark:bg-gray-800 rounded">
				<div class="text-xs text-gray-600 dark:text-gray-400 mb-1">
					Unknown message type: {message.type}
				</div>
				<details>
					<summary class="text-xs cursor-pointer text-gray-500">Show raw data</summary>
					<pre class="text-xs mt-2 overflow-x-auto">{JSON.stringify(message, null, 2)}</pre>
				</details>
			</div>
		);
	}

	// Get message UUID and check if synthetic
	const messageUuid = message.uuid;
	const isSynthetic = 'isSynthetic' in message && (message as Record<string, unknown>).isSynthetic;

	// Rewind mode path - wrap with checkbox
	if (rewindMode && messageUuid && onMessageCheckboxChange) {
		// Skip tool progress messages - they're part of tool execution, not separate checkpoints
		if (isSDKToolProgressMessage(message)) {
			return renderedMessage;
		}
		return (
			<div class="flex items-start gap-2" data-message-uuid={messageUuid}>
				<div class="flex items-start pt-3">
					<input
						type="checkbox"
						checked={selectedMessages?.has(messageUuid) || false}
						onChange={(e) =>
							onMessageCheckboxChange(messageUuid, (e.target as HTMLInputElement).checked)
						}
						class="w-5 h-5 rounded border-gray-600 bg-transparent text-amber-500 focus:ring-amber-500 focus:ring-2 focus:ring-offset-dark-900 cursor-pointer transition-colors checked:border-amber-500 hover:border-gray-500"
					/>
				</div>
				<div class="flex-1 min-w-0">{renderedMessage}</div>
			</div>
		);
	}

	// Normal mode (non-rewind) with rewind support
	if (!rewindMode && messageUuid && !isSynthetic && onRewind && sessionId) {
		return (
			<div data-message-uuid={messageUuid}>
				{renderedMessage}
				{rewindingMessageUuid === messageUuid ? (
					<div class="flex justify-end mt-2 pr-2">
						<Spinner size="sm" color="border-amber-500" />
					</div>
				) : (
					<div class="flex justify-end mt-2 pr-2">
						<Tooltip content="Rewind to this message" position="left">
							<IconButton
								size="md"
								onClick={() => onRewind(messageUuid)}
								title="Rewind to here"
								class="text-gray-500 hover:text-amber-600 dark:text-gray-400 dark:hover:text-amber-500 bg-dark-800/80 rounded"
							>
								<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
									/>
								</svg>
							</IconButton>
						</Tooltip>
					</div>
				)}
			</div>
		);
	}

	// Default path - just return the rendered message as-is
	return renderedMessage;
}
