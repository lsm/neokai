import { describe, it, expect, beforeEach } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createLoopDetectorHook } from '../../../../src/lib/agent/loop-detector-hook';

const signal = new AbortController().signal;

function makePreToolUse(
	tool_name: string,
	tool_input: Record<string, unknown>,
	cwd = '/test/cwd'
): PreToolUseHookInput {
	return {
		hook_event_name: 'PreToolUse',
		tool_name,
		tool_input,
		session_id: 'test-session',
		transcript_path: '/test/path',
		cwd,
		tool_use_id: 'test-id',
	};
}

async function call(hook: HookCallback, input: PreToolUseHookInput) {
	return hook(input, 'test-id', { signal });
}

describe('LoopDetectorHook', () => {
	let hook: HookCallback;

	beforeEach(() => {
		hook = createLoopDetectorHook();
	});

	describe('Read', () => {
		it('passes through below the threshold', async () => {
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			expect(await call(hook, input)).toEqual({});
			expect(await call(hook, input)).toEqual({});
		});

		it('denies on the third consecutive identical Read', async () => {
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			await call(hook, input);
			await call(hook, input);
			const result = await call(hook, input);

			expect(result).toMatchObject({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
				},
			});
			const reason = (
				result as {
					hookSpecificOutput: { permissionDecisionReason: string };
				}
			).hookSpecificOutput.permissionDecisionReason;
			expect(reason).toContain('Loop detected');
			expect(reason).toContain('Read');
			expect(reason).toContain('/abs/foo.ts');
			expect(reason).toContain('TodoWrite');
		});

		it('normalises relative file paths against cwd so ./foo and foo collide', async () => {
			const a = makePreToolUse('Read', { file_path: './foo.ts' }, '/work');
			const b = makePreToolUse('Read', { file_path: 'foo.ts' }, '/work');
			const c = makePreToolUse('Read', { file_path: '/work/foo.ts' }, '/work');

			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			const result = await call(hook, c);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('different file paths reset the counter', async () => {
			expect(await call(hook, makePreToolUse('Read', { file_path: '/abs/a.ts' }))).toEqual({});
			expect(await call(hook, makePreToolUse('Read', { file_path: '/abs/b.ts' }))).toEqual({});
			expect(await call(hook, makePreToolUse('Read', { file_path: '/abs/c.ts' }))).toEqual({});
			// Still no loop on any single file, so all pass through.
		});

		it('treats different offsets as different keys (paginated reads not penalised)', async () => {
			const a = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 0 });
			const b = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 100 });
			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			// Both stay below threshold: no deny.
		});

		it('resets the counter after a deny so the agent can recover', async () => {
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			await call(hook, input);
			await call(hook, input);
			const denied = await call(hook, input);
			expect(denied).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// Next call is fresh — passes through, doesn't immediately deny again.
			expect(await call(hook, input)).toEqual({});
			expect(await call(hook, input)).toEqual({});
		});
	});

	describe('Grep / Glob', () => {
		it('uses a higher threshold (5) for Grep', async () => {
			const input = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
			for (let i = 0; i < 4; i++) {
				expect(await call(hook, input)).toEqual({});
			}
			const result = await call(hook, input);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('uses a higher threshold (5) for Glob', async () => {
			const input = makePreToolUse('Glob', { pattern: '**/*.ts' });
			for (let i = 0; i < 4; i++) {
				expect(await call(hook, input)).toEqual({});
			}
			const result = await call(hook, input);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('treats key-order as identical for Grep args', async () => {
			const a = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
			const b = makePreToolUse('Grep', { path: 'src', pattern: 'TODO' });
			for (let i = 0; i < 4; i++) {
				expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
			}
			const result = await call(hook, a);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});
	});

	describe('untracked tools', () => {
		it('does not track Bash even when called many times with identical args', async () => {
			const input = makePreToolUse('Bash', { command: 'git status', description: 'status' });
			for (let i = 0; i < 20; i++) {
				expect(await call(hook, input)).toEqual({});
			}
		});

		it('passes through unknown tools', async () => {
			const input = makePreToolUse('SomeRandomTool', { foo: 'bar' });
			for (let i = 0; i < 10; i++) {
				expect(await call(hook, input)).toEqual({});
			}
		});

		it('ignores non-PreToolUse events', async () => {
			const result = await hook(
				{
					hook_event_name: 'PostToolUse',
					tool_name: 'Read',
					tool_input: { file_path: '/abs/foo.ts' },
					tool_response: 'whatever',
					session_id: 's',
					transcript_path: '/t',
					cwd: '/c',
					tool_use_id: 'x',
				} as unknown as PreToolUseHookInput,
				'x',
				{ signal }
			);
			expect(result).toEqual({});
		});
	});

	describe('configuration', () => {
		it('respects a custom threshold', async () => {
			const customHook = createLoopDetectorHook({ thresholds: { Read: 2 } });
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			expect(await call(customHook, input)).toEqual({});
			const result = await call(customHook, input);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('disables entirely when enabled=false', async () => {
			const offHook = createLoopDetectorHook({ enabled: false });
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			for (let i = 0; i < 10; i++) {
				expect(await call(offHook, input)).toEqual({});
			}
		});

		it('merges partial threshold overrides with defaults (Grep stays tracked at the default)', async () => {
			const merged = createLoopDetectorHook({
				thresholds: { Read: 3 },
			});
			// Read override sticks at 3.
			const readInput = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			expect(await call(merged, readInput)).toEqual({});
			expect(await call(merged, readInput)).toEqual({});
			expect(await call(merged, readInput)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});

			// Grep was NOT overridden, so the default threshold of 5 is preserved.
			// (This is the merge-with-defaults behaviour documented on
			// `createLoopDetectorHook`.)
			const grepInput = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
			for (let i = 0; i < 4; i++) {
				expect(await call(merged, grepInput)).toEqual({});
			}
			expect(await call(merged, grepInput)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});
	});

	describe('sliding window', () => {
		it('resets the counter when the window expires', async () => {
			const shortWindowHook = createLoopDetectorHook({ windowMs: 1 });
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

			expect(await call(shortWindowHook, input)).toEqual({});
			expect(await call(shortWindowHook, input)).toEqual({});
			// Wait so the window expires before the third call.
			await new Promise((r) => setTimeout(r, 5));
			// Third call is treated as the first in a new window — no deny.
			expect(await call(shortWindowHook, input)).toEqual({});
		});
	});
});
