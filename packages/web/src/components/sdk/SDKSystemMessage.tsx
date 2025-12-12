/**
 * SDKSystemMessage Renderer
 *
 * Renders system messages:
 * - init: Session initialization with tools, models, permissions
 * - compact_boundary: Compaction metadata
 * - status: Status updates (compacting, etc.)
 * - hook_response: Hook execution results
 */

import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import {
	isSDKSystemInit,
	isSDKCompactBoundary,
	isSDKStatusMessage,
	isSDKHookResponse,
} from '@liuboer/shared/sdk/type-guards';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface Props {
	message: SystemMessage;
	/** Optional synthetic content to display inside compact boundary */
	syntheticContent?: string;
}

export function SDKSystemMessage({ message, syntheticContent }: Props) {
	// Init message - session started
	if (isSDKSystemInit(message)) {
		return <SystemInitMessage message={message} />;
	}

	// Compact boundary - shows when message compaction occurred
	if (isSDKCompactBoundary(message)) {
		return <CompactBoundaryMessage message={message} syntheticContent={syntheticContent} />;
	}

	// Status message
	if (isSDKStatusMessage(message)) {
		if (message.status === 'compacting') {
			return (
				<div class="flex items-center gap-3 py-4">
					<div class="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
					<span class="text-xs font-medium text-blue-600 dark:text-blue-400">Compact Boundary</span>
					<div class="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
				</div>
			);
		}
		return null; // Don't show null status
	}

	// Hook response
	if (isSDKHookResponse(message)) {
		return (
			<div class="py-2 px-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
				<div class="text-sm font-medium text-purple-900 dark:text-purple-100 mb-1">
					Hook: {message.hook_name} ({message.hook_event})
				</div>
				{message.stdout && (
					<pre class="text-xs text-purple-700 dark:text-purple-300 whitespace-pre-wrap">
						{message.stdout}
					</pre>
				)}
				{message.stderr && (
					<pre class="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap mt-1">
						{message.stderr}
					</pre>
				)}
				{message.exit_code !== undefined && (
					<div class="text-xs text-purple-600 dark:text-purple-400 mt-1">
						Exit code: {message.exit_code}
					</div>
				)}
			</div>
		);
	}

	return null;
}

/**
 * System Init Message - Shows session startup info
 */
function SystemInitMessage({ message }: { message: Extract<SystemMessage, { subtype: 'init' }> }) {
	const [showDetails, setShowDetails] = useState(false);

	return (
		<div class="py-2 px-3 bg-indigo-50 dark:bg-indigo-900/20 rounded border border-indigo-200 dark:border-indigo-800">
			<button
				onClick={() => setShowDetails(!showDetails)}
				class="w-full flex items-center justify-between hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors -m-1 p-1 rounded"
			>
				<div class="flex items-center gap-2">
					<svg
						class="w-4 h-4 text-indigo-600 dark:text-indigo-400"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M13 10V3L4 14h7v7l9-11h-7z"
						/>
					</svg>
					<div class="text-xs">
						<span class="font-medium text-indigo-900 dark:text-indigo-100">Session Started</span>
						<span class="text-indigo-600 dark:text-indigo-400 ml-2">
							{message.model.replace('claude-', '')} • {message.permissionMode}
						</span>
					</div>
				</div>
				<svg
					class={`w-4 h-4 text-indigo-600 dark:text-indigo-400 transition-transform ${showDetails ? 'rotate-180' : ''}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{showDetails && (
				<div class="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800 space-y-2 text-sm">
					<div>
						<div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
							Working Directory
						</div>
						<div class="font-mono text-xs text-indigo-900 dark:text-indigo-100 bg-indigo-100 dark:bg-indigo-900/30 px-2 py-1 rounded">
							{message.cwd}
						</div>
					</div>

					<div>
						<div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
							Tools ({message.tools.length})
						</div>
						<div class="flex flex-wrap gap-1">
							{message.tools.map((tool) => (
								<span
									key={tool}
									class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
								>
									{tool}
								</span>
							))}
						</div>
					</div>

					{message.mcp_servers.length > 0 && (
						<div>
							<div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
								MCP Servers ({message.mcp_servers.length})
							</div>
							<div class="space-y-1">
								{message.mcp_servers.map((server) => (
									<div
										key={server.name}
										class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-1 rounded flex items-center justify-between"
									>
										<span class="font-mono">{server.name}</span>
										<span
											class={`text-xs ${server.status === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}
										>
											{server.status}
										</span>
									</div>
								))}
							</div>
						</div>
					)}

					{message.slash_commands.length > 0 && (
						<div>
							<div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
								Slash Commands ({message.slash_commands.length})
							</div>
							<div class="flex flex-wrap gap-1">
								{message.slash_commands.map((cmd) => (
									<span
										key={cmd}
										class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
									>
										/{cmd}
									</span>
								))}
							</div>
						</div>
					)}

					{message.agents && message.agents.length > 0 && (
						<div>
							<div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
								Agents ({message.agents.length})
							</div>
							<div class="flex flex-wrap gap-1">
								{message.agents.map((agent) => (
									<span
										key={agent}
										class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded"
									>
										{agent}
									</span>
								))}
							</div>
						</div>
					)}

					<div class="text-xs text-indigo-600 dark:text-indigo-400">
						API Key Source: {message.apiKeySource} • Output: {message.output_style}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Compact Boundary Message - Shows compaction metadata with optional synthetic content
 * Styled similarly to ThinkingBlock for consistency
 */
function CompactBoundaryMessage({
	message,
	syntheticContent,
}: {
	message: Extract<SystemMessage, { subtype: 'compact_boundary' }>;
	syntheticContent?: string;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [needsTruncation, setNeedsTruncation] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const trigger = message.compact_metadata.trigger === 'manual' ? 'Manual' : 'Auto';
	const preTokens = message.compact_metadata.pre_tokens.toLocaleString();

	// Number of lines to show in preview mode (same as ThinkingBlock)
	const PREVIEW_LINE_COUNT = 6;
	const LINE_HEIGHT_PX = 20;
	const PREVIEW_MAX_HEIGHT = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

	// Check if content exceeds preview height
	useLayoutEffect(() => {
		if (contentRef.current && syntheticContent) {
			const scrollHeight = contentRef.current.scrollHeight;
			setNeedsTruncation(scrollHeight > PREVIEW_MAX_HEIGHT);
		}
	}, [syntheticContent]);

	// Blue color scheme for compact blocks (matching thinking block pattern)
	const colors = {
		bg: 'bg-blue-50 dark:bg-blue-900/20',
		text: 'text-blue-900 dark:text-blue-100',
		border: 'border-blue-200 dark:border-blue-800',
		iconColor: 'text-blue-600 dark:text-blue-400',
		lightText: 'text-blue-700 dark:text-blue-300',
	};

	return (
		<div class={`border rounded-lg overflow-hidden ${colors.bg} ${colors.border}`}>
			{/* Header */}
			<div class={`flex items-center gap-2 px-3 py-2 ${colors.bg}`}>
				{/* Compact icon */}
				<svg
					class={`w-4 h-4 flex-shrink-0 ${colors.iconColor}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M4 7h16M4 12h16M4 17h16"
					/>
				</svg>
				<span class={`text-sm font-semibold ${colors.text}`}>Messages Compacted</span>
				<span class={`text-xs ${colors.lightText}`}>
					• {trigger} trigger • {preTokens} tokens before compaction
				</span>
			</div>

			{/* Content area - only show if there's synthetic content */}
			{syntheticContent && (
				<div class={`relative border-t ${colors.border}`}>
					<div
						class={`p-3 bg-white dark:bg-gray-900 ${!isExpanded && needsTruncation ? 'overflow-hidden' : ''}`}
						style={
							!isExpanded && needsTruncation ? { maxHeight: `${PREVIEW_MAX_HEIGHT + 24}px` } : {}
						}
					>
						<div ref={contentRef} class={`text-sm whitespace-pre-wrap ${colors.text}`}>
							{syntheticContent}
						</div>
					</div>

					{/* Gradient fade overlay when truncated and not expanded */}
					{needsTruncation && !isExpanded && (
						<div
							class="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white dark:from-gray-900 to-transparent pointer-events-none"
							aria-hidden="true"
						/>
					)}

					{/* Expand/Collapse button at bottom edge */}
					{needsTruncation && (
						<div
							class={`flex justify-center py-2 border-t bg-white dark:bg-gray-900 ${colors.border}`}
						>
							<button
								onClick={() => setIsExpanded(!isExpanded)}
								class={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors hover:bg-blue-100 dark:hover:bg-blue-900/40 ${colors.text}`}
							>
								{isExpanded ? (
									<>
										<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M5 15l7-7 7 7"
											/>
										</svg>
										Show less
									</>
								) : (
									<>
										<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M19 9l-7 7-7-7"
											/>
										</svg>
										Show more
									</>
								)}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
