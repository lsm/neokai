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
 * The /context command returns a user message with isReplay=true containing
 * markdown-formatted breakdown in <local-command-stdout> tags.
 */

import type { ContextInfo, ContextCategoryBreakdown } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { Logger } from '../logger';

interface ParsedContextInfo {
	model: string;
	totalUsed: number;
	totalCapacity: number;
	percentUsed: number;
	breakdown: Record<string, ContextCategoryBreakdown>;
	slashCommandTool?: {
		commands: number;
		totalTokens: number;
	};
}

export class ContextFetcher {
	private logger: Logger;

	constructor(private sessionId: string) {
		this.logger = new Logger(`ContextFetcher ${sessionId}`);
	}

	/**
	 * Check if an SDK message is a /context response
	 * Returns true if the message contains context breakdown
	 */
	isContextResponse(message: SDKMessage): boolean {
		if (message.type !== 'user') return false;

		const userMsg = message as {
			isReplay?: boolean;
			message?: { content?: string };
		};

		if (!userMsg.isReplay) return false;

		const content = userMsg.message?.content || '';
		return content.includes('<local-command-stdout>') && content.includes('Context Usage');
	}

	/**
	 * Parse /context response from SDK message
	 * Returns null if message is not a context response
	 */
	parseContextResponse(message: SDKMessage): ParsedContextInfo | null {
		if (!this.isContextResponse(message)) {
			return null;
		}

		const userMsg = message as {
			message?: { content?: string };
		};

		const content = userMsg.message?.content || '';

		try {
			return this.parseMarkdownContext(content);
		} catch (error) {
			this.logger.warn('Failed to parse context response:', error);
			return null;
		}
	}

	/**
	 * Parse markdown content from <local-command-stdout> tags
	 */
	private parseMarkdownContext(content: string): ParsedContextInfo {
		// Extract content from <local-command-stdout> tags
		const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
		if (!match) {
			throw new Error('No <local-command-stdout> tags found');
		}

		const markdown = match[1];

		// Parse model and capacity from tokens line
		// Example: **Model:** claude-sonnet-4-5-20250929
		// Example: **Tokens:** 62.5k / 200.0k (31%)
		const modelMatch = markdown.match(/\*\*Model:\*\*\s*(\S+)/);
		const tokensMatch = markdown.match(/\*\*Tokens:\*\*\s*([\d.]+)k\s*\/\s*([\d.]+)k\s*\((\d+)%\)/);

		if (!tokensMatch) {
			throw new Error('Failed to parse token usage from markdown');
		}

		const model = modelMatch?.[1] || 'unknown';
		const totalCapacity = parseFloat(tokensMatch[2]) * 1000;

		// Parse category breakdown table
		const breakdown = this.parseCategoryTable(markdown);

		// Recalculate totalUsed from breakdown to be consistent with displayed categories
		// SDK's reported totalUsed excludes Autocompact buffer, but we want to include it
		// Sum all categories except "Free space"
		const totalUsed = Object.entries(breakdown)
			.filter(([category]) => !category.toLowerCase().includes('free space'))
			.reduce((sum, [, data]) => sum + data.tokens, 0);

		const percentUsed = Math.round((totalUsed / totalCapacity) * 100);

		// Parse SlashCommand tool info (optional)
		const slashCommandTool = this.parseSlashCommandInfo(markdown);

		return {
			model,
			totalUsed,
			totalCapacity,
			percentUsed,
			breakdown,
			slashCommandTool,
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
		const tableRegex = /\|\s*([^|]+)\s*\|\s*([\d.]+)(k?)\s*\|\s*([\d.]+)%\s*\|/g;
		let match;

		while ((match = tableRegex.exec(markdown)) !== null) {
			const category = match[1].trim();

			// Skip header row
			if (category === 'Category') continue;

			const tokenValue = parseFloat(match[2]);
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
	 * Parse SlashCommand tool statistics (optional section)
	 * Example:
	 * ### SlashCommand Tool
	 * **Commands:** 0
	 * **Total tokens:** 877
	 */
	private parseSlashCommandInfo(
		markdown: string
	): { commands: number; totalTokens: number } | undefined {
		const commandsMatch = markdown.match(/\*\*Commands:\*\*\s*(\d+)/);
		const tokensMatch = markdown.match(/\*\*Total tokens:\*\*\s*(\d+)/);

		if (commandsMatch && tokensMatch) {
			return {
				commands: parseInt(commandsMatch[1]),
				totalTokens: parseInt(tokensMatch[1]),
			};
		}

		return undefined;
	}

	/**
	 * Merge parsed context with existing ContextInfo from ContextTracker
	 *
	 * Strategy:
	 * - Use detailed breakdown from /context
	 * - Keep API usage stats from stream events
	 * - Update totals and percentages
	 * - Mark source as 'merged'
	 */
	mergeWithStreamContext(
		parsedContext: ParsedContextInfo,
		streamContext: ContextInfo | null
	): ContextInfo {
		return {
			model: parsedContext.model,
			totalUsed: parsedContext.totalUsed,
			totalCapacity: parsedContext.totalCapacity,
			percentUsed: parsedContext.percentUsed,
			breakdown: parsedContext.breakdown,
			slashCommandTool: parsedContext.slashCommandTool,

			// Keep API usage from stream events if available
			apiUsage: streamContext?.apiUsage,

			// Metadata
			lastUpdated: Date.now(),
			source: 'merged',
		};
	}
}
