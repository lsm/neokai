/**
 * Tests for ContextFetcher
 *
 * Coverage for:
 * - isContextResponse: Detecting /context command responses
 * - parseContextResponse: Extracting parsed context info
 * - parseMarkdownContext: Parsing markdown format
 * - parseCategoryTable: Extracting category breakdown
 * - parseSlashCommandInfo: Extracting SlashCommand tool stats
 * - mergeWithStreamContext: Merging with stream context
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ContextFetcher } from '../../../src/lib/agent/context-fetcher';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type { ContextInfo } from '@liuboer/shared';

describe('ContextFetcher', () => {
	let fetcher: ContextFetcher;

	beforeEach(() => {
		fetcher = new ContextFetcher('test-session');
	});

	describe('isContextResponse', () => {
		test('returns true for valid context response', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage
**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(true);
		});

		test('returns false for non-user messages', () => {
			const message: SDKMessage = {
				type: 'assistant',
				message: {
					content: '<local-command-stdout>Context Usage</local-command-stdout>',
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});

		test('returns false when isReplay is false', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: false,
				message: {
					content: '<local-command-stdout>Context Usage</local-command-stdout>',
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});

		test('returns false when isReplay is undefined', () => {
			const message: SDKMessage = {
				type: 'user',
				message: {
					content: '<local-command-stdout>Context Usage</local-command-stdout>',
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});

		test('returns false when content lacks local-command-stdout tags', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: 'Context Usage - some other content',
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});

		test('returns false when content lacks Context Usage text', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: '<local-command-stdout>Some other command output</local-command-stdout>',
				},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});

		test('returns false when message content is undefined', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {},
			} as unknown as SDKMessage;

			expect(fetcher.isContextResponse(message)).toBe(false);
		});
	});

	describe('parseContextResponse', () => {
		test('parses valid context response', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.2k | 1.6% |
| System tools | 14.3k | 7.1% |
| Messages | 45.0k | 22.5% |
| Free space | 137.5k | 68.8% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.model).toBe('claude-sonnet-4-5-20250929');
			expect(result!.totalCapacity).toBe(200000);
			expect(result!.breakdown).toHaveProperty('System prompt');
			expect(result!.breakdown).toHaveProperty('System tools');
			expect(result!.breakdown).toHaveProperty('Messages');
			expect(result!.breakdown['System prompt'].tokens).toBe(3200);
			expect(result!.breakdown['System tools'].tokens).toBe(14300);
			expect(result!.breakdown['Messages'].tokens).toBe(45000);
		});

		test('returns null for non-context response', () => {
			const message: SDKMessage = {
				type: 'assistant',
				message: { content: 'Hello!' },
			} as unknown as SDKMessage;

			expect(fetcher.parseContextResponse(message)).toBeNull();
		});

		test('returns null when parsing fails due to missing tokens line', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
No tokens line here
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);
			expect(result).toBeNull();
		});

		test('returns null when parsing fails due to missing local-command-stdout tags', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `Context Usage
**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)`,
				},
			} as unknown as SDKMessage;

			// First check isContextResponse returns false since it needs both tags and "Context Usage"
			// The implementation checks for <local-command-stdout> in isContextResponse
			expect(fetcher.isContextResponse(message)).toBe(false);
			expect(fetcher.parseContextResponse(message)).toBeNull();
		});

		test('parses context with SlashCommand tool info', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.2k | 1.6% |

### SlashCommand Tool
**Commands:** 5
**Total tokens:** 877
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.slashCommandTool).toBeDefined();
			expect(result!.slashCommandTool!.commands).toBe(5);
			expect(result!.slashCommandTool!.totalTokens).toBe(877);
		});

		test('parses context without k suffix for small token counts', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 0.5k / 200.0k (0%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 500 | 0.3% |
| Messages | 0 | 0.0% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.breakdown['System prompt'].tokens).toBe(500);
			expect(result!.breakdown['Messages'].tokens).toBe(0);
		});

		test('parses context with unknown model when model line is missing', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.2k | 1.6% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.model).toBe('unknown');
		});
	});

	describe('mergeWithStreamContext', () => {
		test('merges parsed context with stream context', () => {
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62500,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {
					'System prompt': { tokens: 3200, percent: 1.6 },
				},
			};

			const streamContext: ContextInfo = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62000,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {},
				apiUsage: {
					inputTokens: 50000,
					outputTokens: 1000,
					cacheCreationInputTokens: 10000,
					cacheReadInputTokens: 5000,
				},
				lastUpdated: Date.now() - 1000,
				source: 'stream',
			};

			const result = fetcher.mergeWithStreamContext(parsedContext, streamContext);

			expect(result.model).toBe('claude-sonnet-4-5-20250929');
			expect(result.totalUsed).toBe(62500);
			expect(result.totalCapacity).toBe(200000);
			expect(result.percentUsed).toBe(31);
			expect(result.breakdown).toEqual(parsedContext.breakdown);
			expect(result.apiUsage).toEqual(streamContext.apiUsage);
			expect(result.source).toBe('merged');
			expect(result.lastUpdated).toBeGreaterThan(0);
		});

		test('merges with null stream context', () => {
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62500,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {},
			};

			const result = fetcher.mergeWithStreamContext(parsedContext, null);

			expect(result.model).toBe('claude-sonnet-4-5-20250929');
			expect(result.apiUsage).toBeUndefined();
			expect(result.source).toBe('merged');
		});

		test('preserves slashCommandTool info in merged result', () => {
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62500,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {},
				slashCommandTool: {
					commands: 3,
					totalTokens: 500,
				},
			};

			const result = fetcher.mergeWithStreamContext(parsedContext, null);

			expect(result.slashCommandTool).toEqual({
				commands: 3,
				totalTokens: 500,
			});
		});
	});

	describe('edge cases', () => {
		test('handles decimal token values correctly', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.567k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.234k | 1.62% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.totalCapacity).toBe(200000);
			expect(result!.breakdown['System prompt'].tokens).toBe(3234);
			expect(result!.breakdown['System prompt'].percent).toBe(1.62);
		});

		test('skips header row in category table', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| Real category | 3.2k | 1.6% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(result!.breakdown).not.toHaveProperty('Category');
			expect(result!.breakdown).toHaveProperty('Real category');
		});

		test('calculates totalUsed excluding Free space', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 10k | 5% |
| Messages | 50k | 25% |
| Free space | 140k | 70% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			// totalUsed should be 10k + 50k = 60k, excluding Free space
			expect(result!.totalUsed).toBe(60000);
		});

		test('handles empty breakdown table', () => {
			const message: SDKMessage = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>
## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 0.0k / 200.0k (0%)

| Category | Tokens | Percentage |
|----------|--------|------------|
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			const result = fetcher.parseContextResponse(message);

			expect(result).not.toBeNull();
			expect(Object.keys(result!.breakdown).length).toBe(0);
			expect(result!.totalUsed).toBe(0);
		});
	});
});
