import { describe, it, expect } from 'bun:test';
import { ContextFetcher } from '../../../src/lib/agent/context-fetcher';

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

		it('should detect context response without explicit "Context Usage" header', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content:
						'<local-command-stdout>**Tokens:** 12,345 / 200,000 (6.2%)</local-command-stdout>',
				},
			};

			expect(fetcher.isContextResponse(message as never)).toBe(true);
		});
	});

	describe('parseContextResponse', () => {
		it('should parse valid context response and calculate totalUsed from breakdown', () => {
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

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			expect(result?.model).toBe('claude-sonnet-4-5-20250929');

			// totalUsed is now calculated from breakdown (sum of all non-free-space categories)
			// 3200 + 14300 + 25 + 45000 = 62525
			expect(result?.totalUsed).toBe(62525);
			expect(result?.totalCapacity).toBe(200000);
			// percentUsed = Math.round(62525 / 200000 * 100) = 31%
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
		});

		it('should return null for non-context messages', () => {
			const message = {
				type: 'assistant',
				message: { content: 'test' },
			};

			const result = fetcher.parseContextResponse(message as never);
			expect(result).toBeNull();
		});

		it('should handle context response with zero tokens (no k suffix)', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>## Context Usage

**Model:** glm-5
**Tokens:** 0 / 200.0k (0%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.7k | 1.4% |
| System tools | 14.3k | 7.2% |
| Messages | 21 | 0.0% |
| Free space | 137.9k | 69.0% |
| Autocompact buffer | 45.0k | 22.5% |

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			// totalUsed = sum of all except Free space: 2700 + 14300 + 21 + 45000 = 62021
			expect(result?.totalUsed).toBe(62021);
			expect(result?.totalCapacity).toBe(200000);
			// percentUsed = Math.round(62021 / 200000 * 100) = 31%
			expect(result?.percentUsed).toBe(31);
			expect(result?.model).toBe('glm-5');
		});

		it('should parse comma-formatted token values and decimal percentages', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>### Session Context

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 12,345 / 200,000 (6.2%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3,200 | 1.6% |
| Messages | 145 | 0.1% |
| Free space | 196,655 | 98.3% |

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			expect(result?.totalCapacity).toBe(200000);
			expect(result?.totalUsed).toBe(3345);
			expect(result?.percentUsed).toBe(2);
			expect(result?.breakdown['System prompt']?.tokens).toBe(3200);
			expect(result?.breakdown.Messages?.tokens).toBe(145);
		});

		it('should parse SDK 0.2.55 format with integer k-notation and Skills sub-table', () => {
			// Exact format captured from SDK 0.2.55 /context output
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>## Context Usage\n\n**Model:** claude-sonnet-4-6  \n**Tokens:** 20.3k / 200k (10%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 3.6k | 1.8% |\n| System tools | 18k | 9.0% |\n| Skills | 61 | 0.0% |\n| Messages | 108 | 0.1% |\n| Free space | 145.3k | 72.6% |\n| Autocompact buffer | 33k | 16.5% |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| keybindings-help | undefined | 61 |\n\n</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);

			expect(result).not.toBeNull();
			// Trailing spaces stripped from model name
			expect(result?.model).toBe('claude-sonnet-4-6');
			// 200k (no decimal) → 200000
			expect(result?.totalCapacity).toBe(200000);
			// totalUsed = 3600 + 18000 + 61 + 108 + 33000 = 54769 (Free space excluded)
			expect(result?.totalUsed).toBe(54769);
			// percentUsed = Math.round(54769 / 200000 * 100) = 27
			expect(result?.percentUsed).toBe(27);

			// Integer k-notation: 18k → 18000 (no decimal point)
			expect(result?.breakdown['System tools']).toEqual({ tokens: 18000, percent: 9.0 });
			// No k suffix: 61 → 61
			expect(result?.breakdown['Skills']).toEqual({ tokens: 61, percent: 0.0 });
			// Fractional k: 3.6k → 3600
			expect(result?.breakdown['System prompt']).toEqual({ tokens: 3600, percent: 1.8 });
			// Autocompact buffer with integer k: 33k → 33000
			expect(result?.breakdown['Autocompact buffer']).toEqual({ tokens: 33000, percent: 16.5 });

			// ### Skills sub-table rows must NOT appear in breakdown
			// ('keybindings-help | undefined | 61' has a non-numeric 'undefined' in the 3rd column)
			expect(result?.breakdown['keybindings-help']).toBeUndefined();
		});

		it('should return null when category table cannot be parsed', () => {
			const message = {
				type: 'user',
				isReplay: true,
				message: {
					content: `<local-command-stdout>## Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 12,345 / 200,000 (6.2%)

No table rows here.

</local-command-stdout>`,
				},
			};

			const result = fetcher.parseContextResponse(message as never);
			expect(result).toBeNull();
		});
	});

	describe('mergeWithStreamContext', () => {
		it('should merge parsed context with stream context', () => {
			// totalUsed is sum of all non-free-space categories: 3200 + 25 = 3225
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 3225,
				totalCapacity: 200000,
				percentUsed: 2,
				breakdown: {
					'System prompt': { tokens: 3200, percent: 1.6 },
					Messages: { tokens: 25, percent: 0.0 },
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

			// Should use parsed context numbers (calculated from breakdown)
			expect(merged.totalUsed).toBe(3225);
			expect(merged.breakdown).toEqual(parsedContext.breakdown);

			// Should keep API usage from stream
			expect(merged.apiUsage).toEqual(streamContext.apiUsage);

			// Should set metadata
			expect(merged.source).toBe('merged');
			expect(merged.lastUpdated).toBeGreaterThan(0);
		});

		it('should work with null stream context', () => {
			// totalUsed is sum of non-free-space categories: 3200
			const parsedContext = {
				model: 'claude-sonnet-4-5-20250929',
				totalUsed: 3200,
				totalCapacity: 200000,
				percentUsed: 2,
				breakdown: {
					'System prompt': { tokens: 3200, percent: 1.6 },
				},
			};

			const merged = fetcher.mergeWithStreamContext(parsedContext, null);

			expect(merged.totalUsed).toBe(3200);
			expect(merged.apiUsage).toBeUndefined();
			expect(merged.source).toBe('merged');
		});
	});
});
