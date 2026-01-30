/**
 * useMessageMaps Hook
 *
 * Memoized computation of various message lookup maps used in ChatContainer.
 * Extracts the complex O(n) and O(n²) mapping logic for tool results, inputs,
 * and session info.
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
 * />
 * ```
 */

import { useMemo } from 'preact/hooks';
import type { SDKMessage, SDKSystemMessage } from '@neokai/shared/sdk/sdk.d.ts';

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
	/** Map of parent tool use IDs to their sub-agent messages */
	subagentMessagesMap: Map<string, SDKMessage[]>;
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

	// Map of parent tool use IDs to their sub-agent messages
	// Sub-agent messages have parent_tool_use_id set to the Task tool's ID
	const subagentMessagesMap = useMemo(() => {
		const map = new Map<string, SDKMessage[]>();
		messages.forEach((msg) => {
			const msgWithParent = msg as SDKMessage & {
				parent_tool_use_id?: string | null;
			};
			if (msgWithParent.parent_tool_use_id) {
				const existing = map.get(msgWithParent.parent_tool_use_id) || [];
				existing.push(msg);
				map.set(msgWithParent.parent_tool_use_id, existing);
			}
		});
		return map;
	}, [messages]);

	return {
		toolResultsMap,
		toolInputsMap,
		sessionInfoMap,
		subagentMessagesMap,
	};
}
