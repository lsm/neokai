/**
 * useMessageMaps Hook
 *
 * Memoized computation of various message lookup maps used in ChatContainer.
 * Extracts the complex O(n) and O(n²) mapping logic for tool results, inputs,
 * session info, and compact boundary handling.
 *
 * @example
 * ```typescript
 * const maps = useMessageMaps(messages, sessionId, removedOutputs);
 *
 * // Use in message rendering
 * <SDKMessageRenderer
 *   message={msg}
 *   toolResultsMap={maps.toolResultsMap}
 *   toolInputsMap={maps.toolInputsMap}
 *   sessionInfo={maps.sessionInfoMap.get(msg.uuid)}
 *   syntheticContent={maps.compactSyntheticMap.get(msg.uuid)}
 *   skipSynthetic={maps.skipSyntheticSet.has(msg.uuid)}
 * />
 * ```
 */

import { useMemo } from 'preact/hooks';
import type { SDKMessage, SDKSystemMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { isSDKCompactBoundary } from '@liuboer/shared/sdk/type-guards';

export interface ToolResultData {
	content: unknown;
	messageUuid: string | undefined;
	sessionId: string;
	isOutputRemoved: boolean;
}

export interface UseMessageMapsResult {
	/** Map of tool use IDs to their results (with metadata for deletion) */
	toolResultsMap: Map<string, ToolResultData>;
	/** Map of tool use IDs to their input data */
	toolInputsMap: Map<string, unknown>;
	/** Map of user message UUIDs to their attached session init info */
	sessionInfoMap: Map<string, SDKSystemMessage>;
	/** Map of compact boundary UUIDs to synthetic content text */
	compactSyntheticMap: Map<string, string>;
	/** Set of synthetic message UUIDs to skip rendering */
	skipSyntheticSet: Set<string>;
}

/**
 * Extract text content from a user message
 */
function extractUserMessageText(msg: SDKMessage): string {
	if (msg.type !== 'user') return '';
	const apiMessage = (msg as { message: { content: unknown } }).message;
	if (Array.isArray(apiMessage.content)) {
		return apiMessage.content
			.map((block: unknown) => {
				const b = block as Record<string, unknown>;
				if (b.type === 'text') return b.text as string;
				return '';
			})
			.filter(Boolean)
			.join('\n');
	} else if (typeof apiMessage.content === 'string') {
		return apiMessage.content;
	}
	return '';
}

/**
 * Check if a message is synthetic (system-generated)
 */
function isSyntheticMessage(msg: SDKMessage): boolean {
	if (msg.type !== 'user') return false;
	const msgWithSynthetic = msg as SDKMessage & { isSynthetic?: boolean };
	// Check isSynthetic flag - all SDK-emitted user messages are marked synthetic by daemon
	if (msgWithSynthetic.isSynthetic) return true;
	// Backward compatibility: check content pattern for legacy messages without flag
	const text = extractUserMessageText(msg);
	return text.startsWith('This session is being continued from a previous conversation');
}

/**
 * Hook for computing memoized message lookup maps
 */
export function useMessageMaps(
	messages: SDKMessage[],
	sessionId: string,
	removedOutputs: string[] = []
): UseMessageMapsResult {
	// Map of tool use IDs to their results
	const toolResultsMap = useMemo(() => {
		const map = new Map<string, ToolResultData>();
		messages.forEach((msg) => {
			if (msg.type === 'user' && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_result' && blockObj.tool_use_id) {
						const toolUseId = blockObj.tool_use_id as string;
						const isRemoved = msg.uuid ? removedOutputs.includes(msg.uuid) : false;
						map.set(toolUseId, {
							content: block,
							messageUuid: msg.uuid,
							sessionId,
							isOutputRemoved: isRemoved,
						});
					}
				});
			}
		});
		return map;
	}, [messages, removedOutputs, sessionId]);

	// Map of tool use IDs to their input data
	const toolInputsMap = useMemo(() => {
		const map = new Map<string, unknown>();
		messages.forEach((msg) => {
			if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_use' && blockObj.id) {
						map.set(blockObj.id as string, blockObj.input);
					}
				});
			}
		});
		return map;
	}, [messages]);

	// Map of user message UUIDs to their attached session init info
	const sessionInfoMap = useMemo(() => {
		const map = new Map<string, SDKSystemMessage>();
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.type === 'system' && msg.subtype === 'init') {
				// Find the most recent user message before this session init
				for (let j = i - 1; j >= 0; j--) {
					if (messages[j].type === 'user' && messages[j].uuid) {
						map.set(messages[j].uuid!, msg as SDKSystemMessage);
						break;
					}
				}
				// If no preceding user message, attach to the first user message after
				if (msg.uuid && !map.has(msg.uuid)) {
					for (let j = i + 1; j < messages.length; j++) {
						if (messages[j].type === 'user' && messages[j].uuid) {
							map.set(messages[j].uuid!, msg as SDKSystemMessage);
							break;
						}
					}
				}
			}
		}
		return map;
	}, [messages]);

	// Compact boundary to synthetic content mapping
	const { compactSyntheticMap, skipSyntheticSet } = useMemo(() => {
		const map = new Map<string, string>();
		const skipSet = new Set<string>();

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			// Use proper type guard for compact boundary detection
			if (isSDKCompactBoundary(msg) && msg.uuid) {
				// Look for the next synthetic user message
				for (let j = i + 1; j < messages.length; j++) {
					const nextMsg = messages[j];
					if (isSyntheticMessage(nextMsg)) {
						const text = extractUserMessageText(nextMsg);
						if (text) {
							map.set(msg.uuid, text);
							if (nextMsg.uuid) {
								skipSet.add(nextMsg.uuid);
							}
						}
						break;
					}
					// Stop searching if we hit a non-user message that's not system
					if (nextMsg.type !== 'user' && nextMsg.type !== 'system') {
						break;
					}
				}
			}
		}

		return { compactSyntheticMap: map, skipSyntheticSet: skipSet };
	}, [messages]);

	return {
		toolResultsMap,
		toolInputsMap,
		sessionInfoMap,
		compactSyntheticMap,
		skipSyntheticSet,
	};
}
