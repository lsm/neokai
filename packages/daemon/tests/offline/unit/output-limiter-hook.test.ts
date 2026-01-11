/**
 * Tests for OutputLimiterHook
 *
 * Coverage for:
 * - createOutputLimiterHook: Hook creation and configuration
 * - limitToolInput: Tool-specific limiting strategies
 * - getOutputLimiterConfigFromSettings: Settings extraction
 * - All tool types: Bash, Read, Grep, Glob
 */

import { describe, test, expect } from 'bun:test';
import {
	createOutputLimiterHook,
	getOutputLimiterConfigFromSettings,
} from '../../../src/lib/agent/output-limiter-hook';
import type { GlobalSettings } from '@liuboer/shared/types/settings';

describe('OutputLimiterHook', () => {
	describe('createOutputLimiterHook', () => {
		test('creates hook with default config', async () => {
			const hook = createOutputLimiterHook();
			expect(typeof hook).toBe('function');
		});

		test('creates hook with custom config', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				bash: { headLines: 50, tailLines: 100 },
			});
			expect(typeof hook).toBe('function');
		});

		test('hook returns empty object when disabled', async () => {
			const hook = createOutputLimiterHook({ enabled: false });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'git log' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('hook returns empty object for non-PreToolUse events', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PostToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'git log' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('hook skips excluded tools', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				excludeTools: ['Bash'],
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'git log' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});
	});

	describe('Bash tool limiting', () => {
		test('wraps complex commands with smart truncation', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				bash: { headLines: 100, tailLines: 200 },
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'git diff --stat' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toHaveProperty('hookSpecificOutput');
			const output = result.hookSpecificOutput as Record<string, unknown>;
			expect(output.permissionDecision).toBe('allow');
			expect(output.updatedInput).toBeDefined();
			const updatedInput = output.updatedInput as Record<string, unknown>;
			expect(updatedInput.command).toContain('tmpfile=$(mktemp)');
			expect(updatedInput.command).toContain('head -n 100');
			expect(updatedInput.command).toContain('tail -n 200');
			expect(updatedInput.description).toContain('first 100 + last 200 lines');
		});

		test('skips commands that already have head/tail', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'git log | head -50' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('skips simple commands like pwd', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'pwd' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('skips simple ls commands', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'ls -la src/' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('skips simple echo commands', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'echo "hello"' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('skips which commands', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			// The regex only matches bare 'which' without arguments
			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'which' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('skips whoami commands', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'whoami' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('returns null when command is undefined', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: {},
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});

		test('preserves existing description', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				bash: { headLines: 50, tailLines: 100 },
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Bash',
					tool_input: { command: 'npm test', description: 'Run tests' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toHaveProperty('hookSpecificOutput');
			const output = result.hookSpecificOutput as Record<string, unknown>;
			const updatedInput = output.updatedInput as Record<string, unknown>;
			expect(updatedInput.description).toBe('Run tests (output: first 50 + last 100 lines)');
		});
	});

	describe('Read tool limiting', () => {
		test('injects limit parameter', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				read: { maxChars: 50000 },
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Read',
					tool_input: { file_path: '/some/file.ts' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toHaveProperty('hookSpecificOutput');
			const output = result.hookSpecificOutput as Record<string, unknown>;
			expect(output.permissionDecision).toBe('allow');
			const updatedInput = output.updatedInput as Record<string, unknown>;
			expect(updatedInput.limit).toBe(1000); // 50000 / 50 chars per line
		});

		test('skips when limit already present', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Read',
					tool_input: { file_path: '/some/file.ts', limit: 500 },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});
	});

	describe('Grep tool limiting', () => {
		test('injects head_limit parameter', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				grep: { maxMatches: 500 },
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Grep',
					tool_input: { pattern: 'TODO', path: '/src' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toHaveProperty('hookSpecificOutput');
			const output = result.hookSpecificOutput as Record<string, unknown>;
			const updatedInput = output.updatedInput as Record<string, unknown>;
			expect(updatedInput.head_limit).toBe(500);
		});

		test('skips when head_limit already present', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Grep',
					tool_input: { pattern: 'TODO', head_limit: 100 },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});
	});

	describe('Glob tool limiting', () => {
		test('injects head_limit parameter', async () => {
			const hook = createOutputLimiterHook({
				enabled: true,
				glob: { maxFiles: 1000 },
			});

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Glob',
					tool_input: { pattern: '**/*.ts' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toHaveProperty('hookSpecificOutput');
			const output = result.hookSpecificOutput as Record<string, unknown>;
			const updatedInput = output.updatedInput as Record<string, unknown>;
			expect(updatedInput.head_limit).toBe(1000);
		});

		test('skips when head_limit already present', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'Glob',
					tool_input: { pattern: '**/*.ts', head_limit: 500 },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});
	});

	describe('Unknown tools', () => {
		test('returns empty object for unknown tools', async () => {
			const hook = createOutputLimiterHook({ enabled: true });

			const result = await hook(
				{
					hook_event_name: 'PreToolUse',
					tool_name: 'UnknownTool',
					tool_input: { someParam: 'value' },
				} as unknown as Parameters<typeof hook>[0],
				'test-tool-id',
				{ signal: new AbortController().signal }
			);

			expect(result).toEqual({});
		});
	});

	describe('getOutputLimiterConfigFromSettings', () => {
		test('returns defaults for empty settings', () => {
			const settings: GlobalSettings = {};
			const config = getOutputLimiterConfigFromSettings(settings);

			expect(config.enabled).toBe(true);
			expect(config.bash.headLines).toBe(100);
			expect(config.bash.tailLines).toBe(200);
			expect(config.read.maxChars).toBe(50000);
			expect(config.grep.maxMatches).toBe(500);
			expect(config.glob.maxFiles).toBe(1000);
			expect(config.excludeTools).toEqual([]);
		});

		test('merges partial settings with defaults', () => {
			const settings: GlobalSettings = {
				outputLimiter: {
					enabled: false,
					bash: { headLines: 50 },
				},
			};
			const config = getOutputLimiterConfigFromSettings(settings);

			expect(config.enabled).toBe(false);
			expect(config.bash.headLines).toBe(50);
			expect(config.bash.tailLines).toBe(200); // default
			expect(config.read.maxChars).toBe(50000); // default
		});

		test('applies all custom settings', () => {
			const settings: GlobalSettings = {
				outputLimiter: {
					enabled: true,
					bash: { headLines: 25, tailLines: 50 },
					read: { maxChars: 25000 },
					grep: { maxMatches: 250 },
					glob: { maxFiles: 500 },
					excludeTools: ['Bash', 'Read'],
				},
			};
			const config = getOutputLimiterConfigFromSettings(settings);

			expect(config.enabled).toBe(true);
			expect(config.bash.headLines).toBe(25);
			expect(config.bash.tailLines).toBe(50);
			expect(config.read.maxChars).toBe(25000);
			expect(config.grep.maxMatches).toBe(250);
			expect(config.glob.maxFiles).toBe(500);
			expect(config.excludeTools).toEqual(['Bash', 'Read']);
		});

		test('handles undefined outputLimiter', () => {
			const settings: GlobalSettings = {
				permissionMode: 'prompt',
			};
			const config = getOutputLimiterConfigFromSettings(settings);

			expect(config.enabled).toBe(true);
			expect(config.bash.headLines).toBe(100);
		});
	});
});
