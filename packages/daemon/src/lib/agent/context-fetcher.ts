/**
 * ContextFetcher - Fetches and parses detailed context breakdown
 *
 * Uses the /context slash command to get detailed category breakdown:
 * - System prompt tokens
 * - System tools tokens
 * - MCP tools tokens
 * - Messages tokens
 * - Free space
 * - Autocompact buffer
 *
 * The /context command response format depends on the claude binary version:
 *
 * OLD format (claude binary < ~1.0.53):
 *   A user message with isReplay=true containing markdown-formatted breakdown
 *   wrapped in <local-command-stdout> tags.
 *
 * NEW format (claude binary >= ~1.0.53):
 *   An assistant message where the SDK's sc8() function strips the
 *   <local-command-stdout> wrapper and converts the output to an assistant
 *   message with raw markdown content.
 */

import type { ContextInfo, ContextCategoryBreakdown } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { Logger } from '../logger';

interface ParsedContextInfo {
	model: string;
	totalUsed: number;
	totalCapacity: number;
	percentUsed: number;
	breakdown: Record<string, ContextCategoryBreakdown>;
}

export class ContextFetcher {
	private logger: Logger;

	constructor(private sessionId: string) {
		this.logger = new Logger(`ContextFetcher ${sessionId}`);
	}

	/**
	 * Extract text content from a message's content field.
	 * Handles both string content and array of text blocks (BetaContentBlock[]).
	 */
	private extractTextContent(content: unknown): string {
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: 'text'; text: string } => {
					return (
						typeof block === 'object' &&
						block !== null &&
						(block as { type?: string }).type === 'text'
					);
				})
				.map((block) => block.text)
				.join('');
		}
		return '';
	}

	/**
	 * Check if an SDK message is a /context response.
	 *
	 * Handles two SDK message formats:
	 * 1. OLD: user message with isReplay=true, content wrapped in <local-command-stdout> tags
	 * 2. NEW: assistant message with raw markdown content (no wrapper tags)
	 *
	 * Returns true if the message contains context breakdown
	 */
	isContextResponse(message: SDKMessage): boolean {
		if (message.type === 'user') {
			const userMsg = message as {
				isReplay?: boolean;
				message?: { content?: unknown };
			};

			if (!userMsg.isReplay) return false;

			const content = this.extractTextContent(userMsg.message?.content);
			if (!content.includes('<local-command-stdout>')) return false;

			// SDK output headers can drift by version/provider, but /context output always
			// includes a "**Tokens:**" line in local-command stdout.
			return content.includes('Context Usage') || content.includes('**Tokens:**');
		}

		if (message.type === 'assistant') {
			// New SDK format: assistant message produced by sc8() in the claude binary.
			// The <local-command-stdout> wrapper is stripped; content is raw markdown.
			//
			// NOTE: Unlike the old user/isReplay format (which is protected by both
			// the isReplay flag and UUID matching), this path relies solely on content
			// heuristics with no UUID correlation. The dual-signal guard below
			// (**Tokens:** + | Category |) reduces false-positive risk, but a real
			// assistant response that happens to contain both patterns would be silently
			// consumed and not shown in the UI. This is an acceptable trade-off because
			// the pattern combination is highly specific to /context output.
			const assistantMsg = message as {
				message?: { content?: unknown };
			};

			const content = this.extractTextContent(assistantMsg.message?.content);
			// Must contain the tokens line AND at least one category table row to avoid
			// false-positives on regular assistant messages that mention token counts.
			return content.includes('**Tokens:**') && content.includes('| Category |');
		}

		return false;
	}

	/**
	 * Parse /context response from SDK message
	 * Returns null if message is not a context response
	 */
	parseContextResponse(message: SDKMessage): ParsedContextInfo | null {
		if (message.type === 'user') {
			const userMsg = message as {
				isReplay?: boolean;
				message?: { content?: unknown };
			};

			if (!userMsg.isReplay) {
				return null;
			}

			const content = this.extractTextContent(userMsg.message?.content);
			if (!content.includes('<local-command-stdout>')) {
				return null;
			}

			try {
				return this.parseMarkdownContext(content);
			} catch (error) {
				this.logger.warn('Failed to parse context response (user/isReplay):', error);
				return null;
			}
		}

		if (message.type === 'assistant') {
			// New SDK format: raw markdown content without <local-command-stdout> wrapper
			const assistantMsg = message as {
				message?: { content?: unknown };
			};

			const content = this.extractTextContent(assistantMsg.message?.content);
			if (!content.includes('**Tokens:**') || !content.includes('| Category |')) {
				return null;
			}

			try {
				return this.parseMarkdownTokensAndBreakdown(content);
			} catch (error) {
				this.logger.warn('Failed to parse context response (assistant):', error);
				return null;
			}
		}

		return null;
	}

	/**
	 * Parse markdown content from <local-command-stdout> tags (old SDK format).
	 */
	private parseMarkdownContext(content: string): ParsedContextInfo {
		// Extract content from <local-command-stdout> tags
		const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
		if (!match) {
			throw new Error('No <local-command-stdout> tags found');
		}

		return this.parseMarkdownTokensAndBreakdown(match[1]);
	}

	/**
	 * Parse model, token counts, and category breakdown from raw markdown.
	 * Used by both old format (after stripping <local-command-stdout> tags)
	 * and new format (assistant message with no tags).
	 */
	private parseMarkdownTokensAndBreakdown(markdown: string): ParsedContextInfo {
		// Parse model and capacity from tokens line
		// Example: **Model:** claude-sonnet-4-5-20250929
		// Example: **Tokens:** 62.5k / 200.0k (31%) - when tokens > 0, SDK uses 'k' suffix
		// Example: **Tokens:** 0 / 200.0k (0%) - when tokens is 0 or whole number, no 'k' suffix
		// Example: **Tokens:** 12,345 / 200,000 (6.2%) - some SDK versions/providers use commas
		const modelMatch = markdown.match(/\*\*Model:\*\*\s*(\S+)/);
		// Both values may or may not use "k" suffix depending on provider/version.
		const tokensMatch = markdown.match(
			/\*\*Tokens:\*\*\s*([\d.,]+)(k?)\s*\/\s*([\d.,]+)(k?)\s*\(([\d.]+)%\)/
		);

		if (!tokensMatch) {
			throw new Error('Failed to parse token usage from markdown');
		}

		const model = modelMatch?.[1] || 'unknown';
		const parseTokenValue = (value: string, hasK: boolean): number => {
			const normalized = value.replaceAll(',', '');
			const parsed = parseFloat(normalized);
			return hasK ? parsed * 1000 : parsed;
		};
		const totalCapacity = parseTokenValue(tokensMatch[3], tokensMatch[4] === 'k');

		// Parse category breakdown table
		const breakdown = this.parseCategoryTable(markdown);
		if (Object.keys(breakdown).length === 0) {
			throw new Error('No context category rows parsed');
		}

		// Recalculate totalUsed from breakdown to be consistent with displayed categories
		// SDK's reported totalUsed excludes Autocompact buffer, but we want to include it
		// Sum all categories except "Free space"
		const totalUsed = Object.entries(breakdown)
			.filter(([category]) => !category.toLowerCase().includes('free space'))
			.reduce((sum, [, data]) => sum + data.tokens, 0);

		const percentUsed = Math.round((totalUsed / totalCapacity) * 100);

		return {
			model,
			totalUsed,
			totalCapacity,
			percentUsed,
			breakdown,
		};
	}

	/**
	 * Parse category breakdown table
	 * Example format:
	 * | Category | Tokens | Percentage |
	 * |----------|--------|------------|
	 * | System prompt | 3.2k | 1.6% |
	 * | System tools | 14.3k | 7.1% |
	 */
	private parseCategoryTable(markdown: string): Record<string, ContextCategoryBreakdown> {
		const breakdown: Record<string, ContextCategoryBreakdown> = {};

		// Match table rows: | Category | Tokens | Percentage |
		// Capture 'k' suffix separately to detect thousands
		const tableRegex = /\|\s*([^|]+)\s*\|\s*([\d.,]+)(k?)\s*\|\s*([\d.]+)%\s*\|/g;
		let match;

		while ((match = tableRegex.exec(markdown)) !== null) {
			const category = match[1].trim();

			// Skip header row
			if (category === 'Category') continue;

			const tokenValue = parseFloat(match[2].replaceAll(',', ''));
			const hasK = match[3] === 'k';

			// Apply 1000x multiplier if 'k' suffix present
			const tokens = hasK ? tokenValue * 1000 : tokenValue;
			const percent = parseFloat(match[4]);

			breakdown[category] = {
				tokens: Math.round(tokens),
				percent,
			};
		}

		return breakdown;
	}

	/**
	 * Convert parsed /context output to ContextInfo
	 */
	toContextInfo(parsedContext: ParsedContextInfo): ContextInfo {
		return {
			model: parsedContext.model,
			totalUsed: parsedContext.totalUsed,
			totalCapacity: parsedContext.totalCapacity,
			percentUsed: parsedContext.percentUsed,
			breakdown: parsedContext.breakdown,
			lastUpdated: Date.now(),
			source: 'context-command',
		};
	}
}
