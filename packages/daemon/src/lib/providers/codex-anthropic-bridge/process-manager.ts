/**
 * Codex Anthropic Bridge — Process Manager
 *
 * Manages the `codex app-server` subprocess and translates its JSON-RPC protocol
 * into an async stream of BridgeEvents consumed by the HTTP server layer.
 *
 * Wire format: JSONL over stdio, no `"jsonrpc":"2.0"` field (lite variant).
 */

import type { CodexDynamicTool } from './translator.js';
import { buildToolNameReverseMap } from './translator.js';
import { Logger } from '../../logger.js';

const logger = new Logger('codex-bridge-process-manager');

// ---------------------------------------------------------------------------
// BridgeEvent — internal event type bridging Codex ↔ HTTP SSE
// ---------------------------------------------------------------------------

export type BridgeEvent =
	| { type: 'text_delta'; text: string }
	| {
			type: 'tool_call';
			callId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			/** Call this to provide the tool result and resume the Codex turn. */
			provideResult: (text: string) => void;
	  }
	| { type: 'turn_done'; inputTokens: number; outputTokens: number }
	| { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// AsyncQueue — decouples the push-based read loop from the pull-based generator
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
		if (this.items.length > 0) return this.items.shift()!;
		return new Promise<T>((resolve) => this.waiters.push(resolve));
	}
}

// ---------------------------------------------------------------------------
// Deferred — simple promise wrapper
// ---------------------------------------------------------------------------

class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (reason: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
		});
	}
}

// ---------------------------------------------------------------------------
// JSON-RPC message shapes (lite variant — no "jsonrpc":"2.0" field)
// ---------------------------------------------------------------------------

type RpcOutgoing = { method: string; id?: number; params?: unknown };

// Codex app-server uses string IDs for server-initiated requests (e.g. "srv-req-1").
// Our outgoing requests use numeric IDs, so responses carry those back as numbers.
type RpcIncoming =
	| { id: number | string; method: string; params: unknown } // server request (string IDs from Codex)
	| { method: string; params?: unknown } // notification
	| { id: number; result: unknown } // response to our request (numeric ID we sent)
	| { id: number; error: { message: string; code?: number } }; // error response

/** Bun subprocess with piped stdio — matches Bun.spawn return shape. */
type PipedProc = {
	readonly stdout: ReadableStream<Uint8Array>;
	kill(): void;
	readonly stdin: { write(data: string): void; flush(): void };
};

export type AppServerAuth =
	| { type: 'api_key'; apiKey: string }
	| {
			type: 'chatgpt';
			accessToken: string;
			chatgptAccountId: string;
			chatgptPlanType?: string;
			refreshAuthTokens?: () => Promise<{
				accessToken: string;
				chatgptAccountId: string;
				chatgptPlanType?: string;
			} | null>;
	  };

// ---------------------------------------------------------------------------
// AppServerConn — low-level JSON-RPC connection to one codex app-server process
// ---------------------------------------------------------------------------

export class AppServerConn {
	private nextId = 1;
	private readonly pendingRequests = new Map<
		number,
		{ resolve: (r: unknown) => void; reject: (e: Error) => void }
	>();
	private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
	private readonly serverRequestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
	private readonly closedDeferred = new Deferred<void>();

	private constructor(private readonly proc: PipedProc) {
		void this.readLoop();
	}

	static create(codexPath: string, cwd: string, _auth?: AppServerAuth): AppServerConn {
		const subEnv: Record<string, string> = { ...process.env } as Record<string, string>;
		logger.debug(`AppServerConn: spawning ${codexPath} app-server`);
		const proc = Bun.spawn(
			[codexPath, 'app-server', '-c', 'cli_auth_credentials_store="ephemeral"'],
			{
				cwd,
				env: subEnv,
				stdout: 'pipe',
				// Use 'inherit' so stderr flows to the parent process stderr instead of
				// buffering in a pipe.  A full stderr pipe blocks the child when the kernel
				// buffer fills up (typically 64 KB), which would deadlock the app-server.
				stderr: 'inherit',
				stdin: 'pipe',
			}
		) as unknown as PipedProc;
		return new AppServerConn(proc);
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	onServerRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
		this.serverRequestHandlers.set(method, handler);
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		const deferred = new Deferred<unknown>();
		this.pendingRequests.set(id, {
			resolve: deferred.resolve,
			reject: deferred.reject,
		});
		this.write({ method, id, ...(params !== undefined ? { params } : {}) } as RpcOutgoing);
		return deferred.promise as Promise<T>;
	}

	notify(method: string, params?: unknown): void {
		this.write({ method, ...(params !== undefined ? { params } : {}) } as RpcOutgoing);
	}

	get closed(): Promise<void> {
		return this.closedDeferred.promise;
	}

	kill(): void {
		logger.debug('AppServerConn: killing subprocess');
		this.proc.kill();
	}

	private write(msg: unknown): void {
		const line = JSON.stringify(msg) + '\n';
		this.proc.stdin.write(line);
		this.proc.stdin.flush();
	}

	private async readLoop(): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
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
					const trimmed = line.trim();
					if (!trimmed) continue;
					let msg: RpcIncoming;
					try {
						msg = JSON.parse(trimmed) as RpcIncoming;
					} catch {
						logger.debug('AppServerConn: skipping non-JSON line:', trimmed);
						continue;
					}
					await this.dispatch(msg);
				}
			}
		} catch (err) {
			logger.error('AppServerConn: read loop error:', err);
		} finally {
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error('AppServerConn: subprocess closed'));
			}
			this.pendingRequests.clear();
			this.closedDeferred.resolve();
		}
	}

	private async dispatch(msg: RpcIncoming): Promise<void> {
		const hasMethod = 'method' in msg;
		const hasId = 'id' in msg;

		if (hasMethod && hasId) {
			// Server request — must respond (Codex uses string IDs like "srv-req-1")
			const req = msg as { id: number | string; method: string; params: unknown };
			logger.debug(`AppServerConn: server request method=${req.method}`);
			const handler = this.serverRequestHandlers.get(req.method);
			try {
				const result = handler ? await handler(req.params) : {};
				this.write({ id: req.id, result: result ?? {} });
			} catch (err) {
				this.write({ id: req.id, error: { code: -32603, message: String(err) } });
			}
			return;
		}

		if (hasMethod && !hasId) {
			// Notification
			const notif = msg as { method: string; params?: unknown };
			logger.debug(`AppServerConn: notification method=${notif.method}`);
			this.notificationHandlers.get(notif.method)?.(notif.params);
			return;
		}

		if (!hasMethod && hasId) {
			// Response to one of our requests (numeric IDs we sent)
			const resp = msg as
				| { id: number; result: unknown }
				| { id: number; error: { message: string } };
			const id = (resp as { id: number }).id;
			const pending = this.pendingRequests.get(id);
			if (pending) {
				this.pendingRequests.delete(id);
				if ('error' in resp) {
					pending.reject(new Error(resp.error.message));
				} else {
					pending.resolve(resp.result);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// BridgeSession — one Codex thread producing BridgeEvents for one turn
// ---------------------------------------------------------------------------

// codex 0.114+: thread/start returns { thread: { id: "..." }, ... }
type ThreadStartResult = { thread: { id: string } };
// codex 0.114+: turn/start returns { turn: { id: "..." }, ... }
type TurnStartResult = { turn: { id: string } };

export type TokenUsage = {
	inputTokens: number;
	outputTokens: number;
};

export class BridgeSession {
	private threadId: string | null = null;
	private readonly queue = new AsyncQueue<BridgeEvent | Error>();
	private turnStarted = false;
	/** Token usage captured from the most recent thread/tokenUsage/updated notification. */
	private latestUsage: TokenUsage | null = null;
	/**
	 * Reverse map: codex tool name (single-underscore) → original Anthropic tool name.
	 * Used to restore `mcp_server_tool` → `mcp__server__tool` on tool call interception.
	 */
	private readonly toolNameReverseMap: Map<string, string>;

	constructor(
		private readonly conn: AppServerConn,
		private readonly model: string,
		private readonly tools: CodexDynamicTool[],
		private readonly cwd: string,
		private readonly auth?: AppServerAuth,
		originalToolNames: string[] = []
	) {
		this.toolNameReverseMap = buildToolNameReverseMap(originalToolNames);
		conn.closed.then(() =>
			this.queue.push(new Error('codex app-server subprocess closed unexpectedly'))
		);
	}

	async initialize(): Promise<void> {
		await this.conn.request<unknown>('initialize', {
			clientInfo: { name: 'neokai', title: 'NeoKai', version: '1.0.0' },
			capabilities: { experimentalApi: true },
		});
		this.conn.notify('initialized');

		if (this.auth?.type === 'api_key') {
			await this.conn.request<unknown>('account/login/start', {
				type: 'apiKey',
				apiKey: this.auth.apiKey,
			});
		} else if (this.auth?.type === 'chatgpt') {
			const refreshAuthTokens = this.auth.refreshAuthTokens;
			const chatgptAuth = {
				accessToken: this.auth.accessToken,
				chatgptAccountId: this.auth.chatgptAccountId,
				chatgptPlanType: this.auth.chatgptPlanType,
			};

			await this.conn.request<unknown>('account/login/start', {
				type: 'chatgptAuthTokens',
				accessToken: chatgptAuth.accessToken,
				chatgptAccountId: chatgptAuth.chatgptAccountId,
				chatgptPlanType: chatgptAuth.chatgptPlanType ?? null,
			});

			this.conn.onServerRequest('account/chatgptAuthTokens/refresh', async () => {
				const refreshed = await refreshAuthTokens?.();
				if (refreshed) {
					chatgptAuth.accessToken = refreshed.accessToken;
					chatgptAuth.chatgptAccountId = refreshed.chatgptAccountId;
					chatgptAuth.chatgptPlanType = refreshed.chatgptPlanType;
				}
				return {
					accessToken: chatgptAuth.accessToken,
					chatgptAccountId: chatgptAuth.chatgptAccountId,
					chatgptPlanType: chatgptAuth.chatgptPlanType ?? null,
				};
			});
		}

		const res = await this.conn.request<ThreadStartResult>('thread/start', {
			model: this.model,
			workingDirectory: this.cwd,
			dynamicTools: this.tools,
			sandboxPolicy: { type: 'readOnly' },
		});
		this.threadId = res.thread.id;
		logger.debug(`BridgeSession: thread started threadId=${this.threadId}`);

		// Capture accurate token usage from the app-server notification.
		// This notification arrives after the model finishes generating and before
		// (or around the same time as) turn/completed.  We store it so that
		// turn/completed can populate turn_done with real counts instead of zeros.
		this.conn.onNotification('thread/tokenUsage/updated', (rawParams) => {
			// The Codex app-server may send usage as a nested object or flat:
			//   { threadId, usage: { inputTokens, outputTokens } }
			//   { threadId, inputTokens, outputTokens }
			const params = rawParams as {
				usage?: { inputTokens?: number; outputTokens?: number };
				inputTokens?: number;
				outputTokens?: number;
			};
			const inputTokens = params?.usage?.inputTokens ?? params?.inputTokens ?? 0;
			const outputTokens = params?.usage?.outputTokens ?? params?.outputTokens ?? 0;
			logger.debug(
				`BridgeSession: thread/tokenUsage/updated inputTokens=${inputTokens} outputTokens=${outputTokens}`
			);
			this.latestUsage = { inputTokens, outputTokens };
		});

		// Wire notification handlers
		this.conn.onNotification('item/agentMessage/delta', (rawParams) => {
			// codex 0.114.0+ (v2 protocol): delta is a plain string, not an object.
			// AgentMessageDeltaNotification = { threadId, turnId, itemId, delta: string }
			const params = rawParams as { delta?: string | { type?: string; text?: string } };
			let text: string | undefined;
			if (typeof params?.delta === 'string') {
				// Current v2 protocol: delta is the text directly
				text = params.delta || undefined;
			} else if (typeof params?.delta === 'object' && params.delta !== null) {
				// Legacy protocol fallback: delta was { type: 'output_text', text: '...' }
				text = params.delta.text || undefined;
			}
			logger.debug(`BridgeSession: agentMessage/delta text=${JSON.stringify(text)}`);
			if (text) {
				this.queue.push({ type: 'text_delta', text });
			}
		});

		this.conn.onNotification('turn/completed', (rawParams) => {
			// codex 0.114.0+ (v2 protocol):
			//   TurnCompletedNotification = { threadId, turn: { id, items, status, error } }
			// Token usage arrives separately in thread/tokenUsage/updated (captured above).
			// Legacy protocol had usage in this notification; v2 sends it separately.
			const params = rawParams as {
				turn?: { id?: string; status?: string; error?: { message?: string } | null };
				usage?: { inputTokens?: number; outputTokens?: number };
			};
			const status = params?.turn?.status;
			logger.debug(`BridgeSession: turn/completed status=${status}`);
			if (status === 'failed') {
				const msg = params?.turn?.error?.message ?? 'Turn failed';
				this.queue.push({ type: 'error', message: msg });
			} else {
				// Prefer token counts from thread/tokenUsage/updated (v2 protocol), then
				// fall back to inline usage in turn/completed (legacy protocol), then 0.
				const inputTokens = this.latestUsage?.inputTokens ?? params?.usage?.inputTokens ?? 0;
				const outputTokens = this.latestUsage?.outputTokens ?? params?.usage?.outputTokens ?? 0;
				this.queue.push({ type: 'turn_done', inputTokens, outputTokens });
			}
		});

		// Handle server-side error notifications (e.g. invalid model, API errors)
		this.conn.onNotification('error', (rawParams) => {
			const params = rawParams as {
				error?: { message?: string };
				willRetry?: boolean;
			};
			if (!params?.willRetry) {
				const msg = params?.error?.message ?? 'Unknown codex error';
				logger.error(`BridgeSession: codex error notification: ${msg}`);
				// Only push if the error is not going to be retried automatically.
				// turn/completed with status='failed' will also fire and is the canonical
				// signal; this handler is belt-and-suspenders for errors that have no turn.
			}
		});

		// Tool call interception — the core of the Dynamic Tools mechanism
		this.conn.onServerRequest('item/tool/call', async (rawParams) => {
			const params = rawParams as {
				callId: string;
				tool: string;
				arguments: Record<string, unknown>;
			};
			// Restore the original Anthropic tool name (e.g. mcp_server_tool →
			// mcp__server__tool) so callers see the name they registered.
			const originalToolName = this.toolNameReverseMap.get(params.tool) ?? params.tool;
			const deferred = new Deferred<string>();
			this.queue.push({
				type: 'tool_call',
				callId: params.callId,
				toolName: originalToolName,
				toolInput: params.arguments,
				provideResult: (text: string) => deferred.resolve(text),
			});
			// Block the read loop (and Codex) until the tool result is provided.
			const text = await deferred.promise;
			return {
				success: true,
				contentItems: [{ type: 'inputText', text }],
			};
		});

		// Auto-accept built-in tool approvals (belt-and-suspenders with sandboxPolicy)
		const autoAccept = async () => ({ decision: 'accept' });
		this.conn.onServerRequest('item/commandExecution/requestApproval', autoAccept);
		this.conn.onServerRequest('item/fileChange/requestApproval', autoAccept);
		this.conn.onServerRequest('item/permissions/requestApproval', autoAccept);
	}

	/** Start a new turn and return an async generator of BridgeEvents. */
	async *startTurn(userText: string): AsyncGenerator<BridgeEvent> {
		if (!this.threadId) throw new Error('BridgeSession not initialized');
		if (this.turnStarted) throw new Error('BridgeSession.startTurn() called more than once');
		this.turnStarted = true;

		const res = await this.conn.request<TurnStartResult>('turn/start', {
			threadId: this.threadId,
			// input must be an array of content blocks (codex 0.114+ protocol)
			input: [{ type: 'text', text: userText }],
		});
		logger.debug(`BridgeSession: turn started turnId=${res.turn.id}`);

		while (true) {
			const item = await this.queue.next();
			if (item instanceof Error) {
				yield { type: 'error', message: item.message };
				return;
			}
			yield item;
			if (item.type === 'turn_done' || item.type === 'error') return;
		}
	}

	kill(): void {
		this.conn.kill();
	}
}
