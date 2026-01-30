/**
 * SDKSystemMessage Renderer
 *
 * Renders system messages:
 * - init: Session initialization with tools, models, permissions
 * - compact_boundary: Compaction metadata
 * - status: Status updates (compacting, etc.)
 * - hook_response: Hook execution results
 */

import { useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	isSDKSystemInit,
	isSDKCompactBoundary,
	isSDKStatusMessage,
	isSDKHookResponse,
} from '@neokai/shared/sdk/type-guards';
import { customColors } from '../../lib/design-tokens.ts';

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface Props {
	message: SystemMessage;
}

export function SDKSystemMessage({ message }: Props) {
	// Init message - session started
	if (isSDKSystemInit(message)) {
		return <SystemInitMessage message={message} />;
	}

	// Compact boundary - shows when message compaction occurred
	if (isSDKCompactBoundary(message)) {
		return <CompactBoundaryMessage message={message} />;
	}

	// Status message
	if (isSDKStatusMessage(message)) {
		if (message.status === 'compacting') {
			return (
				<div class="flex items-center gap-3 py-4">
					<div
						class="flex-1 h-px"
						style={{ backgroundColor: customColors.canaryYellow.light }}
					></div>
					<span class="text-xs font-medium text-yellow-600 dark:text-yellow-400">
						Compact Boundary
					</span>
					<div
						class="flex-1 h-px"
						style={{ backgroundColor: customColors.canaryYellow.light }}
					></div>
				</div>
			);
		}
		return null; // Don't show null status
	}

	// Hook response
	if (isSDKHookResponse(message)) {
		return (
			<div class="py-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
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
		<div class="py-2 bg-indigo-50 dark:bg-indigo-900/20 rounded border border-indigo-200 dark:border-indigo-800">
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
 * Compact Boundary Message - Shows compaction metadata only
 */
function CompactBoundaryMessage({
	message,
}: {
	message: Extract<SystemMessage, { subtype: 'compact_boundary' }>;
}) {
	const [isExpanded, setIsExpanded] = useState(false);

	// Yellow/amber color scheme with canary yellow borders for visibility
	const colors = {
		bg: 'bg-yellow-50 dark:bg-yellow-900/20',
		text: 'text-yellow-900 dark:text-yellow-100',
		borderColor: customColors.canaryYellow.light,
		iconColor: 'text-yellow-600 dark:text-yellow-400',
		lightText: 'text-yellow-700 dark:text-yellow-300',
	};

	const trigger = message.compact_metadata.trigger === 'manual' ? 'Manual' : 'Auto';
	const preTokens = message.compact_metadata.pre_tokens.toLocaleString();

	return (
		<div class="my-2">
			<div
				class={`border rounded-lg overflow-hidden ${colors.bg}`}
				style={{ borderColor: colors.borderColor }}
			>
				{/* Header - clickable to expand/collapse */}
				<button
					onClick={() => setIsExpanded(!isExpanded)}
					class="w-full flex items-center justify-between p-3 transition-colors hover:bg-opacity-80 dark:hover:bg-opacity-80"
				>
					<div class="flex items-center gap-2 min-w-0 flex-1">
						{/* Compress/zip icon */}
						<svg
							class={`w-5 h-5 flex-shrink-0 ${colors.iconColor}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
							/>
						</svg>
						<span class={`font-semibold text-sm flex-shrink-0 ${colors.text}`}>Compact</span>
						<span class={`text-sm font-mono truncate ${colors.lightText}`}>
							{trigger} • {preTokens} tokens
						</span>
					</div>

					<div class="flex items-center gap-2 flex-shrink-0">
						{/* Chevron icon */}
						<svg
							class={`w-5 h-5 transition-transform ${colors.iconColor} ${isExpanded ? 'rotate-180' : ''}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</div>
				</button>

				{/* Expanded content - metadata details */}
				{isExpanded && (
					<div
						class="p-3 border-t bg-white dark:bg-gray-900"
						style={{ borderColor: colors.borderColor }}
					>
						<div class={`text-xs font-semibold mb-2 ${colors.lightText}`}>Metadata:</div>
						<pre
							class={`text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-yellow-100 dark:bg-yellow-900/30 p-2 rounded ${colors.text}`}
						>
							{JSON.stringify(message.compact_metadata, null, 2)}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
