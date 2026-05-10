import { describe, it, expect, beforeEach } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createLoopDetectorHook } from '../../../../src/lib/agent/loop-detector-hook';

const signal = new AbortController().signal;

function makePreToolUse(
	tool_name: string,
	tool_input: Record<string, unknown>,
	overrides: Partial<PreToolUseHookInput> = {}
): PreToolUseHookInput {
	return {
		hook_event_name: 'PreToolUse',
		tool_name,
		tool_input,
		session_id: 'test-session',
		transcript_path: '/test/path',
		cwd: '/test/cwd',
		tool_use_id: 'test-id',
		...overrides,
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

	describe('Read — consecutive streak semantics', () => {
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
			const a = makePreToolUse('Read', { file_path: './foo.ts' }, { cwd: '/work' });
			const b = makePreToolUse('Read', { file_path: 'foo.ts' }, { cwd: '/work' });
			const c = makePreToolUse('Read', { file_path: '/work/foo.ts' }, { cwd: '/work' });

			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			const result = await call(hook, c);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('a different tracked call in between resets the consecutive streak', async () => {
			const a = makePreToolUse('Read', { file_path: '/abs/a.ts' });
			const b = makePreToolUse('Read', { file_path: '/abs/b.ts' });
			// Read(a) -> Read(b) -> Read(a) -> Read(a) should NOT deny:
			// only two Read(a) calls are consecutive.
			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, a)).toEqual({});
			// One more identical Read(a) makes it three in a row — denies.
			const result = await call(hook, a);
			expect(result).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('treats different offsets as different keys (paginated reads not penalised)', async () => {
			const a = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 0 });
			const b = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 100 });
			// Alternating offsets — never two in a row of the same key.
			for (let i = 0; i < 6; i++) {
				expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
			}
		});

		it('continues to deny on every retry of the same key after a deny (until a different action)', async () => {
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			await call(hook, input);
			await call(hook, input);
			// First deny.
			expect(await call(hook, input)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// Repeated identical retries keep denying — the loop is broken,
			// not just throttled.
			expect(await call(hook, input)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			expect(await call(hook, input)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});

			// A different action resets the streak; the next identical Read passes.
			const other = makePreToolUse('Read', { file_path: '/abs/other.ts' });
			expect(await call(hook, other)).toEqual({});
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
		it('does not deny on Bash even when called many times with identical args', async () => {
			const input = makePreToolUse('Bash', { command: 'git status', description: 'status' });
			for (let i = 0; i < 20; i++) {
				expect(await call(hook, input)).toEqual({});
			}
		});

		it('passes through unknown tools without denying', async () => {
			const input = makePreToolUse('SomeRandomTool', { foo: 'bar' });
			for (let i = 0; i < 10; i++) {
				expect(await call(hook, input)).toEqual({});
			}
		});

		it('an untracked tool call DOES reset a tracked streak (Bash counts as a different action)', async () => {
			const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			const bash = makePreToolUse('Bash', { command: 'echo hi' });
			// Read, Bash (untracked, counts as a different action), Read, Read
			// — must NOT deny. Bash reset the streak so we are only on the
			// 2nd consecutive Read here.
			expect(await call(hook, read)).toEqual({});
			expect(await call(hook, bash)).toEqual({});
			expect(await call(hook, read)).toEqual({});
			expect(await call(hook, read)).toEqual({});
			// One more identical Read makes it three in a row — denies.
			expect(await call(hook, read)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('an untracked tool call breaks a denied streak (edit-then-read flow)', async () => {
			// Real-world recovery flow: agent reads X three times and gets
			// denied; agent edits X (untracked tool); next read of X must
			// pass because the edit IS the "different action" the recovery
			// message asked for.
			const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			const edit = makePreToolUse('Edit', {
				file_path: '/abs/foo.ts',
				old_string: 'a',
				new_string: 'b',
			});
			await call(hook, read);
			await call(hook, read);
			expect(await call(hook, read)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// Corrective action via an untracked tool.
			expect(await call(hook, edit)).toEqual({});
			// Streak reset — next two Reads pass.
			expect(await call(hook, read)).toEqual({});
			expect(await call(hook, read)).toEqual({});
			// Third in a row again denies, as expected.
			expect(await call(hook, read)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
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

		it('threshold overrides REPLACE the default tracked-tool set', async () => {
			// Caller asked to track only Read at 2. Grep and Glob must NOT be
			// tracked, even though defaults include them.
			const narrow = createLoopDetectorHook({ thresholds: { Read: 2 } });

			// Read still triggers at 2.
			const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			expect(await call(narrow, read)).toEqual({});
			expect(await call(narrow, read)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});

			// Grep is no longer tracked at all — even 50 identical calls pass.
			const grep = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
			for (let i = 0; i < 50; i++) {
				expect(await call(narrow, grep)).toEqual({});
			}

			// Glob likewise.
			const glob = makePreToolUse('Glob', { pattern: '**/*.ts' });
			for (let i = 0; i < 50; i++) {
				expect(await call(narrow, glob)).toEqual({});
			}
		});

		it('omitting thresholds inherits the defaults wholesale', async () => {
			const inheritsDefaults = createLoopDetectorHook({ windowMs: 30_000 });
			// Read still triggers at the default 3.
			const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			expect(await call(inheritsDefaults, read)).toEqual({});
			expect(await call(inheritsDefaults, read)).toEqual({});
			expect(await call(inheritsDefaults, read)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});
	});

	describe('per-(session, agent) isolation', () => {
		it("does not pollute one session's streak with another session's reads", async () => {
			const a = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { session_id: 'sess-A' });
			const b = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { session_id: 'sess-B' });
			// Two reads in sess-A interleaved with one read in sess-B. The
			// sess-A streak must stay at 2 (no deny) because sess-B should
			// not contribute.
			expect(await call(hook, a)).toEqual({});
			expect(await call(hook, b)).toEqual({});
			expect(await call(hook, a)).toEqual({});
			// One more makes sess-A's third consecutive — should deny.
			expect(await call(hook, a)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// sess-B should still be on count=1 (only one read) — no deny.
			expect(await call(hook, b)).toEqual({});
		});

		it('isolates main thread from subagent (different agent_id)', async () => {
			const main = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: undefined });
			const subagent = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-1' });
			// Subagent reads the same file twice — no deny, its own ledger.
			expect(await call(hook, subagent)).toEqual({});
			expect(await call(hook, subagent)).toEqual({});
			// Main thread also reads twice — independent of subagent.
			expect(await call(hook, main)).toEqual({});
			expect(await call(hook, main)).toEqual({});
			// Main's 3rd read triggers main's deny only.
			expect(await call(hook, main)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// Subagent's 3rd read independently triggers its own deny.
			expect(await call(hook, subagent)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});

		it('isolates two subagents from each other', async () => {
			const subA = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-A' });
			const subB = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-B' });
			// Two reads each, interleaved. Neither should deny.
			expect(await call(hook, subA)).toEqual({});
			expect(await call(hook, subB)).toEqual({});
			expect(await call(hook, subA)).toEqual({});
			expect(await call(hook, subB)).toEqual({});
			// subA's 3rd consecutive in its own scope. subB has 2 reads then
			// a subA in between in the GLOBAL stream — but per-(session,agent)
			// isolation means subB's streak is 2. So neither denies on this
			// next subA call (subA streak = 3 here).
			expect(await call(hook, subA)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
			// subB is still on 2 — one more makes 3 in its own scope.
			expect(await call(hook, subB)).toMatchObject({
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

		it('enforces the window over the FULL streak duration (slow periodic retries are not penalised)', async () => {
			// Fake `Date.now` so we can simulate calls spaced 4ms apart with a
			// 5ms window. Streak duration grows past 5ms on the 3rd call, so
			// it must reset to 1 — matching "N within window" semantics, not
			// "no gap > windowMs".
			const original = Date.now;
			let now = 1_000_000;
			Date.now = () => now;
			try {
				const slowHook = createLoopDetectorHook({ windowMs: 5 });
				const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

				// t = 0: streak count = 1
				expect(await call(slowHook, input)).toEqual({});
				// t = 4: gap is 4 (<= 5), streak duration is 4 (<= 5) → count = 2
				now += 4;
				expect(await call(slowHook, input)).toEqual({});
				// t = 8: gap is 4 (<= 5) BUT streak duration is 8 (> 5).
				// Old "max-gap" logic would advance to count = 3 and deny.
				// Correct "window over full duration" logic resets to 1.
				now += 4;
				expect(await call(slowHook, input)).toEqual({});
				// t = 12: gap 4, duration 4 since reset → count = 2, no deny.
				now += 4;
				expect(await call(slowHook, input)).toEqual({});
			} finally {
				Date.now = original;
			}
		});

		it('still denies bursty repeats well within the window', async () => {
			// Sanity check that a tight burst (much less than windowMs apart)
			// continues to deny — the previous test must not have over-corrected.
			const tightHook = createLoopDetectorHook({ windowMs: 60_000 });
			const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
			await call(tightHook, input);
			await call(tightHook, input);
			expect(await call(tightHook, input)).toMatchObject({
				hookSpecificOutput: { permissionDecision: 'deny' },
			});
		});
	});
});
