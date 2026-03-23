/**
 * Shared ToolResult type, jsonResult helper, and common constants for Space MCP tool handlers.
 *
 * Extracted from space-agent-tools.ts and task-agent-tools.ts to eliminate
 * duplication. Both files previously defined identical types inline.
 */

export interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

export function jsonResult(data: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Common English stop words filtered out by suggest_workflow before keyword matching.
 * Hoisted to module scope so the Set is constructed once across all importers.
 */
export const SUGGEST_WORKFLOW_STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'are',
	'but',
	'not',
	'you',
	'all',
	'can',
	'her',
	'was',
	'one',
	'our',
	'out',
	'day',
	'get',
	'has',
	'him',
	'his',
	'how',
	'its',
	'may',
	'new',
	'now',
	'old',
	'see',
	'two',
	'use',
	'way',
	'who',
	'did',
	'let',
	'put',
	'say',
	'she',
	'too',
	'had',
	'any',
	'via',
]);
