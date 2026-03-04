/**
 * SDK Message Renderer - Routes SDK messages to appropriate renderers
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type {
	SDKAuthStatusMessage,
	SDKMessage,
	SDKRateLimitEvent as SDKRateLimitEventType,
	SDKToolProgressMessage as SDKToolProgressMessageType,
} from '@neokai/shared/sdk/sdk.d.ts';
import type { PendingUserQuestion, QuestionDraftResponse, ResolvedQuestion } from '@neokai/shared';
import {
	isSDKAssistantMessage,
	isSDKResultMessage,
	isSDKSystemMessage,
	isSDKSystemInit,
	isSDKToolProgressMessage,
	isSDKAuthStatusMessage,
	isSDKRateLimitEvent,
	isSDKUserMessage,
	isSDKUserMessageReplay,
	isUserVisibleMessage,
} from '@neokai/shared/sdk/type-guards';

// Component imports
import { SDKAssistantMessage } from './SDKAssistantMessage.tsx';
import { SDKRateLimitEvent } from './SDKRateLimitEvent.tsx';
import { SDKResultMessage } from './SDKResultMessage.tsx';
import { SDKSystemMessage } from './SDKSystemMessage.tsx';
import { SDKToolProgressMessage } from './SDKToolProgressMessage.tsx';
import { SDKUserMessage } from './SDKUserMessage.tsx';
import { AuthStatusCard } from './tools/index.ts';

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
	/** When true, renders all message types without skipping (for task conversation timelines) */
	taskContext?: boolean;
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
 * Compact renderer for system/init messages in task context
 */
function SystemInitPill({ message }: { message: SystemInitMessage }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div class="py-1 px-2">
			<button
				onClick={() => setExpanded(!expanded)}
				class="flex items-center gap-2 text-[10px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
			>
				<svg
					class={`w-3 h-3 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
				</svg>
				<span class="font-medium">{message.model ?? 'unknown model'}</span>
				{message.mcp_servers && message.mcp_servers.length > 0 && (
					<span>
						· {message.mcp_servers.length} MCP server
						{message.mcp_servers.length !== 1 ? 's' : ''}
					</span>
				)}
				{message.tools && <span>· {message.tools.length} tools</span>}
			</button>

			{expanded && (
				<div class="mt-1.5 ml-5 space-y-1.5 text-[10px] text-gray-500">
					{message.cwd && (
						<div>
							<span class="font-semibold text-gray-600 dark:text-gray-400">cwd: </span>
							<span class="font-mono">{message.cwd}</span>
						</div>
					)}

					{message.mcp_servers && message.mcp_servers.length > 0 && (
						<div>
							<span class="font-semibold text-gray-600 dark:text-gray-400">MCP Servers: </span>
							{message.mcp_servers.map((server: { name: string; status: string }) => (
								<span key={server.name} class="font-mono">
									{server.name}
									<span class={server.status === 'connected' ? 'text-green-600 dark:text-green-400' : ''}>
										({server.status})
									</span>{' '}
								</span>
							))}
						</div>
					)}

					{message.tools && message.tools.length > 0 && (
						<div>
							<span class="font-semibold text-gray-600 dark:text-gray-400">
								Tools ({message.tools.length}):{' '}
							</span>
							<span class="font-mono">{message.tools.join(', ')}</span>
						</div>
					)}

					{message.agents && message.agents.length > 0 && (
						<div>
							<span class="font-semibold text-gray-600 dark:text-gray-400">
								Agents ({message.agents.length}):{' '}
							</span>
							<span class="font-mono">{message.agents.join(', ')}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
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
	taskContext,
}: Props) {
	// Skip messages that shouldn't be shown to user (e.g., stream events)
	if (!isUserVisibleMessage(message)) {
		return null;
	}

	// Skip session init messages - they're now shown as indicators attached to user messages
	// In task context, render them as compact info pills
	if (isSDKSystemInit(message)) {
		if (taskContext) {
			return <SystemInitPill message={message as SystemInitMessage} />;
		}
		return null;
	}

	// Skip sub-agent messages - they're now shown inside SubagentBlock
	if (isSubagentMessage(message)) {
		return null;
	}

	// Compute the rendered message component
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
		// Always render user messages - pass rewind mode props
		renderedMessage = (
			<SDKUserMessage
				message={message}
				sessionInfo={sessionInfo}
				sessionId={sessionId}
				onRewind={rewindMode ? undefined : onRewind}
				rewindingMessageUuid={rewindMode ? undefined : rewindingMessageUuid}
				rewindMode={rewindMode}
				selectedMessages={selectedMessages}
				onMessageCheckboxChange={onMessageCheckboxChange}
				allMessages={_allMessages}
			/>
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
				rewindMode={rewindMode}
				selectedMessages={selectedMessages}
				onMessageCheckboxChange={onMessageCheckboxChange}
				allMessages={_allMessages}
			/>
		);
	} else if (isSDKResultMessage(message)) {
		renderedMessage = <SDKResultMessage message={message} />;
	} else if (isSDKSystemMessage(message)) {
		renderedMessage = <SDKSystemMessage message={message} />;
	} else if (isSDKToolProgressMessage(message)) {
		const toolInput = toolInputsMap?.get((message as SDKToolProgressMessageType).tool_use_id);
		renderedMessage = <SDKToolProgressMessage message={message} toolInput={toolInput} />;
	} else if (isSDKAuthStatusMessage(message)) {
		const authMessage = message as SDKAuthStatusMessage;
		renderedMessage = (
			<AuthStatusCard
				isAuthenticating={authMessage.isAuthenticating}
				output={authMessage.output}
				error={authMessage.error}
				variant="default"
			/>
		);
	} else if (isSDKRateLimitEvent(message)) {
		renderedMessage = <SDKRateLimitEvent message={message as SDKRateLimitEventType} />;
	} else {
		// Fallback for unknown message types (shouldn't happen, but safe)
		renderedMessage = (
			<div class="p-3 bg-gray-100 dark:bg-gray-800 rounded">
				<div class="text-xs text-gray-600 dark:text-gray-400 mb-1">
					Unknown message type: {(message as SDKMessage).type}
				</div>
				<details>
					<summary class="text-xs cursor-pointer text-gray-500">Show raw data</summary>
					<pre class="text-xs mt-2 overflow-x-auto">{JSON.stringify(message, null, 2)}</pre>
				</details>
			</div>
		);
	}

	// Default path - just return the rendered message as-is
	// Checkbox rendering is now handled by individual message components
	return renderedMessage;
}
