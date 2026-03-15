/**
 * Codex App Server Adapter
 *
 * Provides integration with the OpenAI Codex CLI `codex app-server` subprocess as a
 * long-lived JSON-RPC 2.0 (lite) daemon. Uses the Dynamic Tools API (experimentalApi: true)
 * so the LLM's tool calls are intercepted by NeoKai via `item/tool/call` server requests,
 * allowing NeoKai to retain full control over tool execution, approval, logging, and
 * permission checks — just like the Claude Agent SDK.
 *
 * Wire format: JSONL over stdio, no `"jsonrpc":"2.0"` field (lite variant).
 */

import type { UUID } from 'crypto';
import type {
	SDKMessage,
	SDKUserMessage,
	SDKSystemMessage,
	SDKToolProgressMessage,
	SDKResultMessage,
	SDKAssistantMessage,
} from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
	ToolDefinition,
} from '@neokai/shared/provider/query-types';
import { generateUUID } from '@neokai/shared';
import { Logger } from '../logger.js';
import { findCodexCli } from './codex-cli-adapter.js';

const logger = new Logger('codex-app-server-adapter');

// ---------------------------------------------------------------------------
// Tool execution callback type (mirrors pimono-adapter)
// ---------------------------------------------------------------------------

/**
 * Tool execution callback type.
 * Called when the Codex app-server sends an `item/tool/call` server request.
 */
export type ToolExecutionCallback = (
	toolName: string,
	toolInput: Record<string, unknown>,
	toolUseId: string
) => Promise<{ output: unknown; isError: boolean }>;

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface CodexAppServerAdapterConfig {
	/** Path to the codex binary. Defaults to 'codex'. */
	codexPath?: string;
	/** Model ID to pass to codex (e.g. 'gpt-5.3-codex'). */
	model: string;
	/** API key — written to OPENAI_API_KEY / CODEX_API_KEY in the subprocess env. */
	apiKey?: string;
}

// ---------------------------------------------------------------------------
// App Server JSON-RPC protocol types
// ---------------------------------------------------------------------------

/** Any message that can arrive from the server (discriminated via shape) */
type AppServerIncoming =
	| { id: string | number; method: string; params: unknown }
	| { method: string; params?: unknown }
	| { id: number; result: unknown }
	| { id: number; error: { message: string; code?: number } };

interface DynamicToolCallParams {
	threadId: string;
	turnId: string;
	callId: string;
	tool: string;
	arguments: Record<string, unknown>;
}

interface DynamicToolCallResponse {
	success: boolean;
	contentItems: Array<
		{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
	>;
}

interface ApprovalResponse {
	decision: 'accept' | 'reject';
}

interface ThreadStartResult {
	threadId: string;
}

interface TurnStartResult {
	turnId: string;
}

interface AgentMessageDeltaParams {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: { type: 'text_delta'; text: string } | { type: string };
}

interface ItemStartedParams {
	threadId: string;
	turnId: string;
	item: { id: string; type: string; [key: string]: unknown };
}

interface ItemCompletedParams {
	threadId: string;
	turnId: string;
	item: { id: string; type: string; status?: string; text?: string; [key: string]: unknown };
}

interface TurnCompletedParams {
	threadId: string;
	turnId: string;
	usage?: { inputTokens: number; outputTokens: number };
}

/** Subprocess type alias (Bun.spawn with piped stdio) */
type PipedProc = {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(): void;
	readonly stdin: {
		write(data: string): void;
		flush(): void;
	};
};

// ---------------------------------------------------------------------------
// AsyncQueue helper
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
	private items: T[] = [];
	private waiters: Array<(item: T) => void> = [];

	push(item: T): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(item);
		} else {
			this.items.push(item);
		}
	}

	async next(): Promise<T> {
		if (this.items.length > 0) {
			return this.items.shift()!;
		}
		return new Promise<T>((resolve) => this.waiters.push(resolve));
	}
}

// ---------------------------------------------------------------------------
// AppServerConnection
// ---------------------------------------------------------------------------

/**
 * Manages the `codex app-server` subprocess lifecycle and JSON-RPC message passing.
 *
 * The read loop multiplexes three message shapes from stdout:
 *   1. Server requests  — have both `method` AND `id` — client MUST respond
 *   2. Notifications    — have `method` only          — no response needed
 *   3. Responses        — have `id` only              — resolves a pending request
 */
class AppServerConnection {
	private nextId = 1;

	/** Pending client→server requests: id → { resolve, reject } */
	private pendingRequests = new Map<
		number,
		{ resolve: (r: unknown) => void; reject: (e: Error) => void }
	>();

	/** Registered server request handlers: method → async handler */
	private serverRequestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

	/** Registered notification handlers: method → sync handler */
	private notificationHandlers = new Map<string, (params: unknown) => void>();

	/** Background read loop — resolves when stdout closes */
	private readLoopPromise: Promise<void>;

	private constructor(private readonly proc: PipedProc) {
		this.readLoopPromise = this.readLoop();
	}

	// -------------------------------------------------------------------------
	// Factory
	// -------------------------------------------------------------------------

	static async create(
		codexPath: string,
		cwd: string,
		apiKey?: string
	): Promise<AppServerConnection> {
		const subEnv: Record<string, string> = { ...process.env } as Record<string, string>;
		if (apiKey) {
			subEnv['OPENAI_API_KEY'] = apiKey;
			subEnv['CODEX_API_KEY'] = apiKey;
		}

		logger.debug(`AppServerConnection: spawning ${codexPath} app-server`);

		const proc = Bun.spawn([codexPath, 'app-server'], {
			cwd,
			env: subEnv,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'pipe',
		}) as unknown as PipedProc;

		return new AppServerConnection(proc);
	}

	// -------------------------------------------------------------------------
	// High-level protocol methods
	// -------------------------------------------------------------------------

	async initialize(): Promise<void> {
		await this.request<unknown>('initialize', {
			clientInfo: { name: 'neokai', title: 'NeoKai', version: '1.0.0' },
			capabilities: { experimentalApi: true },
		});
		// Send the `initialized` notification (no response expected)
		this.notify('initialized');
	}

	async startThread(model: string, cwd: string, tools: ToolDefinition[]): Promise<string> {
		const dynamicTools = tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			deferLoading: false,
		}));

		const result = await this.request<ThreadStartResult>('thread/start', {
			model,
			workingDirectory: cwd,
			dynamicTools,
		});
		return result.threadId;
	}

	async startTurn(threadId: string, text: string): Promise<string> {
		const result = await this.request<TurnStartResult>('turn/start', {
			threadId,
			input: { type: 'text', text },
		});
		return result.turnId;
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.request<unknown>('turn/interrupt', { threadId, turnId });
	}

	// -------------------------------------------------------------------------
	// Read loop completion signal
	// -------------------------------------------------------------------------

	/**
	 * Resolves when the read loop exits (stdout closed or error).
	 * Callers can use this to unblock when the subprocess closes without sending
	 * a `turn/completed` notification.
	 */
	get closed(): Promise<void> {
		return this.readLoopPromise;
	}

	// -------------------------------------------------------------------------
	// Handler registration
	// -------------------------------------------------------------------------

	onServerRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
		this.serverRequestHandlers.set(method, handler);
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	// -------------------------------------------------------------------------
	// Low-level send
	// -------------------------------------------------------------------------

	async request<T>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, {
				resolve: (r) => resolve(r as T),
				reject,
			});
			this.write({ method, id, ...(params !== undefined ? { params } : {}) });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write({ method, ...(params !== undefined ? { params } : {}) });
	}

	private write(msg: Record<string, unknown>): void {
		const line = JSON.stringify(msg) + '\n';
		this.proc.stdin.write(line);
		this.proc.stdin.flush();
	}

	// -------------------------------------------------------------------------
	// Read loop
	// -------------------------------------------------------------------------

	private async readLoop(): Promise<void> {
		const reader = this.proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.trim()) continue;

					let msg: AppServerIncoming;
					try {
						msg = JSON.parse(line) as AppServerIncoming;
					} catch {
						logger.debug('AppServerConnection: skipping non-JSON line:', line);
						continue;
					}

					await this.dispatchMessage(msg);
				}
			}
		} catch (err) {
			logger.error('AppServerConnection: read loop error:', err);
		} finally {
			// Reject all pending requests since the connection is closed
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error('AppServerConnection: subprocess closed'));
			}
			this.pendingRequests.clear();
		}
	}

	private async dispatchMessage(msg: AppServerIncoming): Promise<void> {
		const hasMethod = 'method' in msg;
		const hasId = 'id' in msg;

		if (hasMethod && hasId) {
			// Server request — must respond
			const serverReq = msg as { id: string | number; method: string; params: unknown };
			logger.debug(`AppServerConnection: server request method=${serverReq.method}`);
			const handler = this.serverRequestHandlers.get(serverReq.method);
			if (handler) {
				try {
					const result = await handler(serverReq.params);
					this.write({ id: serverReq.id, result });
				} catch (err) {
					logger.error(`AppServerConnection: handler error for ${serverReq.method}:`, err);
					const errMsg = err instanceof Error ? err.message : 'Internal handler error';
					this.write({ id: serverReq.id, error: { code: -32603, message: errMsg } });
				}
			} else {
				logger.debug(
					`AppServerConnection: no handler for server request method=${serverReq.method}`
				);
				// No handler registered — send an error so the server isn't left waiting
				this.write({
					id: serverReq.id,
					error: { code: -32601, message: `Method not found: ${serverReq.method}` },
				});
			}
		} else if (hasMethod) {
			// Notification — no response needed
			const notif = msg as { method: string; params?: unknown };
			logger.debug(`AppServerConnection: notification method=${notif.method}`);
			this.notificationHandlers.get(notif.method)?.(notif.params);
		} else if (hasId) {
			// Response to one of our requests
			const resp = msg as
				| { id: number; result: unknown }
				| { id: number; error: { message: string } };
			const pending = this.pendingRequests.get((resp as { id: number }).id);
			if (pending) {
				this.pendingRequests.delete((resp as { id: number }).id);
				if ('error' in resp) {
					pending.reject(new Error(resp.error.message));
				} else {
					pending.resolve(resp.result);
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------------

	kill(): void {
		logger.debug('AppServerConnection: killing subprocess');
		this.proc.kill();
		// Drain the read loop promise to avoid unhandled promise rejections
		this.readLoopPromise.catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Message factories (mirrors codex-cli-adapter / pimono-adapter patterns)
// ---------------------------------------------------------------------------

function createSystemInitMessage(
	sessionId: string,
	options: ProviderQueryOptions
): SDKSystemMessage {
	return {
		type: 'system',
		subtype: 'init',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		cwd: options.cwd,
		model: options.model,
		permissionMode: (options.permissionMode as SDKSystemMessage['permissionMode']) || 'default',
		tools: options.tools.map((t) => t.name),
		mcp_servers: [],
		slash_commands: [],
		output_style: 'default',
		skills: [],
		plugins: [],
		apiKeySource: 'user',
		claude_code_version: 'codex-app-server-adapter',
	};
}

function createStreamEvent(sessionId: string, text: string): SDKMessage {
	return {
		type: 'stream_event',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: null,
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: {
				type: 'text_delta',
				text,
			},
		} as unknown as SDKMessage extends { type: 'stream_event' } ? SDKMessage['event'] : never,
	};
}

function createAssistantMessage(sessionId: string, text: string): SDKAssistantMessage {
	return {
		type: 'assistant',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: null,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text }],
		},
	} as unknown as SDKAssistantMessage;
}

function createToolProgressMessage(
	sessionId: string,
	toolName: string,
	toolUseId: string,
	elapsedSeconds: number
): SDKToolProgressMessage {
	return {
		type: 'tool_progress',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		tool_name: toolName,
		tool_use_id: toolUseId,
		parent_tool_use_id: null,
		elapsed_time_seconds: elapsedSeconds,
	};
}

function createResultMessage(
	sessionId: string,
	success: boolean,
	durationMs: number,
	numTurns: number,
	resultText: string,
	errorMessage?: string,
	usage?: { inputTokens: number; outputTokens: number }
): SDKResultMessage {
	const base = {
		type: 'result' as const,
		duration_ms: durationMs,
		duration_api_ms: durationMs,
		num_turns: numTurns,
		total_cost_usd: 0,
		usage: {
			input_tokens: usage?.inputTokens ?? 0,
			output_tokens: usage?.outputTokens ?? 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [] as Array<{
			tool_name: string;
			tool_use_id: string;
			tool_input: Record<string, unknown>;
		}>,
		session_id: sessionId,
		uuid: generateUUID() as UUID,
	};

	if (success) {
		return {
			...base,
			subtype: 'success',
			is_error: false,
			result: resultText,
			stop_reason: 'end_turn',
		} as SDKResultMessage;
	}

	return {
		...base,
		subtype: 'error_during_execution',
		is_error: true,
		errors: [errorMessage ?? 'Unknown error'],
		stop_reason: errorMessage ?? 'Unknown error',
	} as SDKResultMessage;
}

// ---------------------------------------------------------------------------
// Text extraction from SDK user message
// ---------------------------------------------------------------------------

function extractTextFromUserMessage(message: SDKUserMessage): string {
	const content = message.message.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
			.map((block) => block.text)
			.join('\n');
	}
	return '';
}

// ---------------------------------------------------------------------------
// Item types that generate tool_progress messages
// ---------------------------------------------------------------------------

const TOOL_ITEM_TYPES = new Set([
	'commandExecution',
	'fileChange',
	'mcpToolCall',
	'dynamicToolCall',
]);

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Codex App Server query generator.
 *
 * Spawns `codex app-server` as a long-lived subprocess and uses the JSON-RPC
 * Dynamic Tools API to intercept tool calls. When the LLM wants to call a tool,
 * Codex sends an `item/tool/call` server request; NeoKai executes it via
 * `toolExecutor` and returns the result so the LLM can continue.
 *
 * Only the first user message from `prompt` is consumed — matching the pattern
 * used by piMonoQueryGenerator and codexExecQueryGenerator.
 */
export async function* codexAppServerQueryGenerator(
	prompt: AsyncGenerator<SDKUserMessage>,
	options: ProviderQueryOptions,
	context: ProviderQueryContext,
	config: CodexAppServerAdapterConfig,
	toolExecutor?: ToolExecutionCallback
): AsyncGenerator<SDKMessage, void, unknown> {
	const startTime = Date.now();
	let turnCount = 0;
	let finalUsage: { inputTokens: number; outputTokens: number } | undefined;

	// CRITICAL: Only consume ONE message from the prompt generator.
	// The prompt generator is designed for streaming input mode where it yields
	// one message and then blocks. Using `for await` would hang indefinitely.
	const firstMessage = await prompt.next();
	if (firstMessage.done) {
		logger.warn('Codex app-server adapter: prompt generator yielded no messages');
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			'No user message provided'
		);
		return;
	}

	const userMessage = firstMessage.value;

	if (context.signal.aborted) {
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			'Query aborted'
		);
		return;
	}

	const promptText = extractTextFromUserMessage(userMessage);
	if (!promptText.trim()) {
		logger.warn('Codex app-server adapter: user message contains no text');
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			'Empty user message'
		);
		return;
	}

	// Resolve codex binary path
	const codexBin = config.codexPath ?? findCodexCli() ?? 'codex';

	let conn: AppServerConnection;
	try {
		conn = await AppServerConnection.create(codexBin, options.cwd, config.apiKey);
	} catch (spawnError) {
		const msg =
			spawnError instanceof Error ? spawnError.message : 'Failed to spawn codex app-server';
		logger.error('Codex app-server: spawn failed:', spawnError);
		yield createResultMessage(context.sessionId, false, Date.now() - startTime, turnCount, '', msg);
		return;
	}

	// Accumulated state
	const toolStartTimes = new Map<string, number>();
	let accumulatedText = '';
	const queue = new AsyncQueue<SDKMessage | 'done' | Error>();

	// Track the current turn IDs so the abort handler can interrupt
	let currentThreadId: string | undefined;
	let currentTurnId: string | undefined;

	// Abort handler — interrupt the current turn
	const abortHandler = () => {
		logger.debug('Codex app-server: aborting due to signal');
		if (currentThreadId && currentTurnId) {
			conn.interruptTurn(currentThreadId, currentTurnId).catch(() => {});
		} else {
			conn.kill();
		}
	};
	context.signal.addEventListener('abort', abortHandler, { once: true });

	try {
		// ------------------------------------------------------------------
		// Register server request handlers
		// ------------------------------------------------------------------

		// Dynamic tool call — the LLM wants NeoKai to execute a tool
		conn.onServerRequest('item/tool/call', async (rawParams) => {
			const params = rawParams as DynamicToolCallParams;
			logger.debug(`Codex app-server: tool call tool=${params.tool} callId=${params.callId}`);

			if (!toolExecutor) {
				logger.warn(`Codex app-server: no toolExecutor available for tool=${params.tool}`);
				const response: DynamicToolCallResponse = {
					success: false,
					contentItems: [{ type: 'inputText', text: 'No tool executor available' }],
				};
				return response;
			}

			try {
				const result = await toolExecutor(params.tool, params.arguments, params.callId);
				const resultText =
					typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
				const text = result.isError ? `[Tool Error] ${resultText}` : resultText;

				const response: DynamicToolCallResponse = {
					success: !result.isError,
					contentItems: [{ type: 'inputText', text }],
				};
				return response;
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
				logger.error(`Codex app-server: tool execution error for ${params.tool}:`, err);
				const response: DynamicToolCallResponse = {
					success: false,
					contentItems: [{ type: 'inputText', text: `[Tool Error] ${errMsg}` }],
				};
				return response;
			}
		});

		// Built-in approval requests — auto-accept all for autonomous operation
		const autoAccept = async (_params: unknown): Promise<ApprovalResponse> => ({
			decision: 'accept',
		});
		conn.onServerRequest('item/commandExecution/requestApproval', autoAccept);
		conn.onServerRequest('item/fileChange/requestApproval', autoAccept);
		conn.onServerRequest('item/permissions/requestApproval', autoAccept);

		// ------------------------------------------------------------------
		// Register notification handlers
		// ------------------------------------------------------------------

		conn.onNotification('item/agentMessage/delta', (rawParams) => {
			const params = rawParams as AgentMessageDeltaParams;
			if (params.delta.type === 'text_delta') {
				const textDelta = (params.delta as { type: 'text_delta'; text: string }).text;
				accumulatedText += textDelta;
				queue.push(createStreamEvent(context.sessionId, textDelta));
			}
		});

		conn.onNotification('item/started', (rawParams) => {
			const params = rawParams as ItemStartedParams;
			const item = params.item;
			if (TOOL_ITEM_TYPES.has(item.type)) {
				toolStartTimes.set(item.id, Date.now());
				queue.push(createToolProgressMessage(context.sessionId, item.type, item.id, 0));
			}
		});

		conn.onNotification('item/completed', (rawParams) => {
			const params = rawParams as ItemCompletedParams;
			const item = params.item;

			if (TOOL_ITEM_TYPES.has(item.type)) {
				const startedAt = toolStartTimes.get(item.id);
				const elapsedSeconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
				toolStartTimes.delete(item.id);
				queue.push(
					createToolProgressMessage(context.sessionId, item.type, item.id, elapsedSeconds)
				);
			} else if (item.type === 'agent_message') {
				const text = typeof item.text === 'string' ? item.text : '';
				if (text) {
					queue.push(createAssistantMessage(context.sessionId, text));
				}
			}
		});

		// `item/commandExecution/outputDelta` is informational — ignored
		conn.onNotification('item/commandExecution/outputDelta', (_params) => {
			// Intentionally not forwarded — it is low-level subprocess output
		});

		conn.onNotification('turn/started', (rawParams) => {
			const params = rawParams as { threadId: string; turnId: string };
			logger.debug(`Codex app-server: turn started turnId=${params.turnId}`);
		});

		conn.onNotification('turn/completed', (rawParams) => {
			const params = rawParams as TurnCompletedParams;
			logger.debug(`Codex app-server: turn completed turnId=${params.turnId}`);
			turnCount++;
			if (params.usage) {
				finalUsage = params.usage;
			}
			queue.push('done');
		});

		// ------------------------------------------------------------------
		// Guard against subprocess crash without turn/completed
		// If stdout closes before the LLM sends turn/completed, push an error
		// sentinel so the drain loop below is unblocked instead of hanging.
		// ------------------------------------------------------------------

		conn.closed.then(() => {
			queue.push(new Error('AppServerConnection: subprocess closed unexpectedly'));
		});

		// ------------------------------------------------------------------
		// Protocol handshake
		// ------------------------------------------------------------------

		try {
			await conn.initialize();
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to initialize codex app-server';
			logger.error('Codex app-server: initialize failed:', err);
			yield createResultMessage(
				context.sessionId,
				false,
				Date.now() - startTime,
				turnCount,
				'',
				msg
			);
			return;
		}

		// Yield system init before the turn begins
		yield createSystemInitMessage(context.sessionId, options);

		// ------------------------------------------------------------------
		// Start thread and turn
		// ------------------------------------------------------------------

		let threadId: string;
		try {
			threadId = await conn.startThread(config.model, options.cwd, options.tools);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to start codex thread';
			logger.error('Codex app-server: startThread failed:', err);
			yield createResultMessage(
				context.sessionId,
				false,
				Date.now() - startTime,
				turnCount,
				'',
				msg
			);
			return;
		}
		currentThreadId = threadId;
		logger.debug(`Codex app-server: thread started threadId=${threadId}`);

		let turnId: string;
		try {
			turnId = await conn.startTurn(threadId, promptText);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to start codex turn';
			logger.error('Codex app-server: startTurn failed:', err);
			yield createResultMessage(
				context.sessionId,
				false,
				Date.now() - startTime,
				turnCount,
				'',
				msg
			);
			return;
		}
		currentTurnId = turnId;
		logger.debug(`Codex app-server: turn started turnId=${turnId}`);

		// ------------------------------------------------------------------
		// Drain the event queue until the turn completes
		// ------------------------------------------------------------------

		while (true) {
			if (context.signal.aborted) break;

			const item = await queue.next();

			if (item === 'done') break;

			if (item instanceof Error) {
				yield createResultMessage(
					context.sessionId,
					false,
					Date.now() - startTime,
					turnCount,
					'',
					item.message,
					finalUsage
				);
				return;
			}

			yield item;
		}
	} finally {
		context.signal.removeEventListener('abort', abortHandler);
		conn.kill();
	}

	// Handle abort
	if (context.signal.aborted) {
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			'Query aborted',
			finalUsage
		);
		return;
	}

	// Success
	yield createResultMessage(
		context.sessionId,
		true,
		Date.now() - startTime,
		turnCount,
		accumulatedText || 'Task completed successfully.',
		undefined,
		finalUsage
	);
}
