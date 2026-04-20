/**
 * Completion Action Executors
 *
 * Runtime-injected executors for the non-script variants of
 * `CompletionAction`. The `SpaceRuntime` takes these via config so that:
 *   - Tests can substitute deterministic stubs without standing up the full
 *     agent SDK or an MCP server.
 *   - Production wires the real executors (LLM-backed instruction verifier
 *     and MCP client) once during `createDaemonApp`.
 *
 * Two action types are supported here:
 *
 *   1. **`instruction`** — spawn a short-lived agent session bound to
 *      `action.agentName`, hand it `action.instruction`, and wait for it to
 *      call `report_verification(pass, reason)`. Bounded by `action.timeoutMs`
 *      (the production executor applies a default of 120_000 ms when unset).
 *
 *   2. **`mcp_call`** — invoke the MCP tool `action.tool` on server
 *      `action.server` with `action.args`, then apply the optional
 *      `action.expect` assertion to the result.
 *
 * Both executors return a uniform `CompletionActionExecutionResult` — a
 * success flag plus an optional `reason` string for audit logging and the
 * task's structured failure message.
 */

import type {
	InstructionCompletionAction,
	McpCallCompletionAction,
	McpCallExpectation,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// Result shape shared by all executors (script/instruction/mcp_call)
// ---------------------------------------------------------------------------

export interface CompletionActionExecutionResult {
	/** Did the action succeed (verifier passed / assertion matched)? */
	success: boolean;
	/** Human-readable reason — shown in task result on failure, audit-logged on success. */
	reason?: string;
}

// ---------------------------------------------------------------------------
// Instruction executor
// ---------------------------------------------------------------------------

export interface InstructionExecutorContext {
	spaceId: string;
	runId: string;
	workspacePath: string;
	artifactData: Record<string, unknown>;
}

/**
 * Runs an `instruction` completion action. Implementations should:
 *
 *   1. Resolve `action.agentName` to a SpaceAgent.
 *   2. Start an ephemeral session with that agent, injecting a
 *      `report_verification(pass: boolean, reason: string)` MCP tool.
 *   3. Send `action.instruction` (template-interpolated if applicable) as the
 *      user message.
 *   4. Resolve once the agent calls `report_verification`, or the timeout
 *      elapses (→ `{ success: false, reason: 'timed out' }`).
 */
export type InstructionActionExecutor = (
	action: InstructionCompletionAction,
	ctx: InstructionExecutorContext
) => Promise<CompletionActionExecutionResult>;

// ---------------------------------------------------------------------------
// MCP-call executor
// ---------------------------------------------------------------------------

export interface McpCallExecutorContext {
	spaceId: string;
	runId: string;
	workspacePath: string;
	artifactData: Record<string, unknown>;
}

/**
 * Invokes an MCP tool. Returns the tool's raw result so the caller can apply
 * the optional `expect` assertion — separation lets us unit-test assertions
 * against a fake tool result without mocking the whole MCP transport.
 */
export type McpToolExecutor = (
	action: McpCallCompletionAction,
	ctx: McpCallExecutorContext
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Assertion evaluation — applied to `mcp_call.result` when `expect` is set
// ---------------------------------------------------------------------------

/**
 * Navigate into a value using a dot/bracket accessor path.
 * `''` returns the root value. Missing segments yield `undefined`.
 *
 * Supports:
 *   - Dot access: `data.items.status`
 *   - Bracket access: `data.items[0]`, `data['foo bar']`
 */
export function accessByPath(root: unknown, path: string): unknown {
	if (!path) return root;

	// Parse path into segments respecting dots, [n] and ['...'] notations.
	const segments: string[] = [];
	let i = 0;
	let buf = '';
	while (i < path.length) {
		const ch = path[i];
		if (ch === '.') {
			if (buf) {
				segments.push(buf);
				buf = '';
			}
			i++;
			continue;
		}
		if (ch === '[') {
			if (buf) {
				segments.push(buf);
				buf = '';
			}
			const end = path.indexOf(']', i + 1);
			if (end === -1) {
				// Malformed — treat remainder as literal
				buf = path.slice(i);
				break;
			}
			let key = path.slice(i + 1, end);
			// Strip surrounding quotes if present (single or double)
			if (
				(key.startsWith('"') && key.endsWith('"')) ||
				(key.startsWith("'") && key.endsWith("'"))
			) {
				key = key.slice(1, -1);
			}
			segments.push(key);
			i = end + 1;
			continue;
		}
		buf += ch;
		i++;
	}
	if (buf) segments.push(buf);

	let cursor: unknown = root;
	for (const seg of segments) {
		if (cursor == null) return undefined;
		if (Array.isArray(cursor)) {
			const n = Number(seg);
			cursor = Number.isInteger(n) ? cursor[n] : undefined;
			continue;
		}
		if (typeof cursor === 'object') {
			cursor = (cursor as Record<string, unknown>)[seg];
			continue;
		}
		return undefined;
	}
	return cursor;
}

/**
 * Apply an `expect` assertion to the result of an MCP call.
 *
 * `eq`/`neq` use deep equality via JSON serialization — sufficient for plain
 * primitives / arrays / objects of primitives, which is the only shape MCP
 * tool results are practically expected to contain for a verifier.
 *
 * `contains` works against either strings (substring) or arrays (element
 * membership via JSON equality).
 *
 * `exists` passes when the path resolves to anything other than `undefined`.
 *
 * `truthy` passes when the resolved value is JavaScript-truthy.
 */
export function evaluateMcpExpectation(
	result: unknown,
	expectation: McpCallExpectation
): CompletionActionExecutionResult {
	const actual = accessByPath(result, expectation.path);

	switch (expectation.op) {
		case 'exists':
			return actual !== undefined
				? { success: true }
				: {
						success: false,
						reason: `expected path "${expectation.path}" to exist, got undefined`,
					};
		case 'truthy':
			return actual
				? { success: true }
				: {
						success: false,
						reason: `expected path "${expectation.path}" to be truthy, got ${describe(actual)}`,
					};
		case 'eq':
			return deepEqual(actual, expectation.value)
				? { success: true }
				: {
						success: false,
						reason: `expected "${expectation.path}" to equal ${describe(expectation.value)}, got ${describe(actual)}`,
					};
		case 'neq':
			return !deepEqual(actual, expectation.value)
				? { success: true }
				: {
						success: false,
						reason: `expected "${expectation.path}" not to equal ${describe(expectation.value)}`,
					};
		case 'contains':
			return containsValue(actual, expectation.value)
				? { success: true }
				: {
						success: false,
						reason: `expected "${expectation.path}" to contain ${describe(expectation.value)}, got ${describe(actual)}`,
					};
		default: {
			// Exhaustiveness: McpCallExpectation.op is a closed union — adding a
			// new variant without a case is a type error here.
			const _never: never = expectation.op;
			void _never;
			return { success: false, reason: `unknown expect op: ${String(expectation.op)}` };
		}
	}
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function containsValue(container: unknown, needle: unknown): boolean {
	if (typeof container === 'string') {
		return typeof needle === 'string' && container.includes(needle);
	}
	if (Array.isArray(container)) {
		return container.some((item) => deepEqual(item, needle));
	}
	return false;
}

function describe(v: unknown): string {
	if (v === undefined) return 'undefined';
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

// ---------------------------------------------------------------------------
// `mcp_call` action runner — combines the tool executor + assertion
// ---------------------------------------------------------------------------

/**
 * Run an `mcp_call` action: invoke the tool then apply the optional `expect`.
 * No assertion → any non-throwing tool call is success. A throwing tool call
 * is always a failure and surfaces the error message in `reason`.
 */
export async function runMcpCallAction(
	action: McpCallCompletionAction,
	ctx: McpCallExecutorContext,
	executor: McpToolExecutor
): Promise<CompletionActionExecutionResult> {
	let result: unknown;
	try {
		result = await executor(action, ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, reason: `mcp_call "${action.tool}" failed: ${message}` };
	}
	if (!action.expect) {
		return { success: true };
	}
	return evaluateMcpExpectation(result, action.expect);
}
