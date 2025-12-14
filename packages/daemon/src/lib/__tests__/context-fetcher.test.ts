import { describe, it, expect } from 'bun:test';
import { ContextFetcher } from '../context-fetcher';

describe('ContextFetcher', () => {
	const fetcher = new ContextFetcher('test-session');

	describe('isContextResponse', () => {
		it('should detect valid context response', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: '<local-command-stdout>## Context Usage\n...',
				},
			};

			expect(fetcher.isContextResponse(message as never)).toBe(true);
		});

		it('should reject non-user messages', () => {
			const message = {
				type: 'assistant',
				message: { content: 'test' },
			};

			expect(fetcher.isContextResponse(message as never)).toBe(false);
		});

		it('should reject user messages without isReplay', () => {
			const message = {
				type: 'user',
				message: { content: '<local-command-stdout>test' },
			};

			expect(fetcher.isContextResponse(message as never)).toBe(false);
		});

		it('should reject messages without context stdout', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: { content: 'just a regular message' },
			};

			expect(fetcher.isContextResponse(message as never)).toBe(false);
		});
	});

	describe('parseContextResponse', () => {
		it('should parse valid context response', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

### Categories

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.2k | 1.6% |
| System tools | 14.3k | 7.1% |
| Messages | 25 | 0.0% |
| Free space | 137.5k | 68.7% |
| Autocompact buffer | 45.0k | 22.5% |

### SlashCommand Tool

**Commands:** 5
**Total tokens:** 877

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			expect(result?.model).toBe('claude-sonnet-4-5-20250929');
			expect(result?.totalUsed).toBe(62500);
			expect(result?.totalCapacity).toBe(200000);
			expect(result?.percentUsed).toBe(31);

			// Check breakdown
			expect(result?.breakdown['System prompt']).toEqual({
				tokens: 3200,
				percent: 1.6,
			});
			expect(result?.breakdown['System tools']).toEqual({
				tokens: 14300,
				percent: 7.1,
			});
			expect(result?.breakdown['Messages']).toEqual({
				tokens: 25,
				percent: 0.0,
			});

			// Check SlashCommand tool
			expect(result?.slashCommandTool).toEqual({
				commands: 5,
				totalTokens: 877,
			});
		});

		it('should return null for non-context messages', () => {
			const message = {
				type: 'assistant',
				message: { content: 'test' },
			};

			const result = fetcher.parseContextResponse(message as never);
			expect(result).toBeNull();
		});

		it('should handle context response without SlashCommand section', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 50.0k / 200.0k (25%)

### Categories

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.0k | 1.5% |
| Free space | 150.0k | 75.0% |

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			expect(result?.slashCommandTool).toBeUndefined();
		});
	});

	describe('mergeWithStreamContext', () => {
		it('should merge parsed context with stream context', () => {
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62500,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {
					'System prompt': { tokens: 3200, percent: 1.6 },
					'Messages': { tokens: 25, percent: 0.0 },
				},
			};

			const streamContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 60000,
				totalCapacity: 200000,
				percentUsed: 30,
				breakdown: {
					'Input Context': { tokens: 30000, percent: 15 },
					'Output Tokens': { tokens: 30000, percent: 15 },
				},
				apiUsage: {
					inputTokens: 30000,
					outputTokens: 30000,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
				},
			};

			const merged = fetcher.mergeWithStreamContext(parsedContext, streamContext);

			// Should use parsed context numbers (more detailed)
			expect(merged.totalUsed).toBe(62500);
			expect(merged.breakdown).toEqual(parsedContext.breakdown);

			// Should keep API usage from stream
			expect(merged.apiUsage).toEqual(streamContext.apiUsage);

			// Should set metadata
			expect(merged.source).toBe('merged');
			expect(merged.lastUpdated).toBeGreaterThan(0);
		});

		it('should work with null stream context', () => {
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 62500,
				totalCapacity: 200000,
				percentUsed: 31,
				breakdown: {
					'System prompt': { tokens: 3200, percent: 1.6 },
				},
			};

			const merged = fetcher.mergeWithStreamContext(parsedContext, null);

			expect(merged.totalUsed).toBe(62500);
			expect(merged.apiUsage).toBeUndefined();
			expect(merged.source).toBe('merged');
		});
	});
});
