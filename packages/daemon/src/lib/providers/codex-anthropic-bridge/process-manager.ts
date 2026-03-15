/**
 * Codex Anthropic Bridge — Process Manager
 *
 * Manages the `codex app-server` subprocess and translates its JSON-RPC protocol
 * into an async stream of BridgeEvents consumed by the HTTP server layer.
 *
 * Wire format: JSONL over stdio, no `"jsonrpc":"2.0"` field (lite variant).
 */

import type { CodexDynamicTool } from './translator.js';
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

type RpcIncoming =
	| { id: number; method: string; params: unknown } // server request
	| { method: string; params?: unknown } // notification
	| { id: number; result: unknown } // response
	| { id: number; error: { message: string; code?: number } }; // error response

/** Bun subprocess with piped stdio — matches Bun.spawn return shape. */
type PipedProc = {
	readonly stdout: ReadableStream<Uint8Array>;
	kill(): void;
	readonly stdin: { write(data: string): void; flush(): void };
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

	static create(codexPath: string, cwd: string, apiKey: string): AppServerConn {
		const subEnv: Record<string, string> = { ...process.env } as Record<string, string>;
		if (apiKey) {
			subEnv['OPENAI_API_KEY'] = apiKey;
			subEnv['CODEX_API_KEY'] = apiKey;
		}
		logger.debug(`AppServerConn: spawning ${codexPath} app-server`);
		const proc = Bun.spawn([codexPath, 'app-server'], {
			cwd,
			env: subEnv,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'pipe',
		}) as unknown as PipedProc;
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
			// Server request — must respond
			const req = msg as { id: number; method: string; params: unknown };
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
			// Response to one of our requests
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

type ThreadStartResult = { threadId: string };
type TurnStartResult = { turnId: string };

export class BridgeSession {
	private threadId: string | null = null;
	private readonly queue = new AsyncQueue<BridgeEvent | Error>();

	constructor(
		private readonly conn: AppServerConn,
		private readonly model: string,
		private readonly tools: CodexDynamicTool[],
		private readonly cwd: string
	) {
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

		const res = await this.conn.request<ThreadStartResult>('thread/start', {
			model: this.model,
			workingDirectory: this.cwd,
			dynamicTools: this.tools,
			sandboxPolicy: { type: 'readOnly' },
		});
		this.threadId = res.threadId;
		logger.debug(`BridgeSession: thread started threadId=${this.threadId}`);

		// Wire notification handlers
		this.conn.onNotification('item/agentMessage/delta', (rawParams) => {
			const params = rawParams as {
				delta: { type: string; text?: string };
			};
			if (params?.delta?.type === 'text_delta' && params.delta.text) {
				this.queue.push({ type: 'text_delta', text: params.delta.text });
			}
		});

		this.conn.onNotification('turn/completed', (rawParams) => {
			const params = rawParams as {
				usage?: { inputTokens?: number; outputTokens?: number };
			};
			this.queue.push({
				type: 'turn_done',
				inputTokens: params?.usage?.inputTokens ?? 0,
				outputTokens: params?.usage?.outputTokens ?? 0,
			});
		});

		// Tool call interception — the core of the Dynamic Tools mechanism
		this.conn.onServerRequest('item/tool/call', async (rawParams) => {
			const params = rawParams as {
				callId: string;
				tool: string;
				arguments: Record<string, unknown>;
			};
			const deferred = new Deferred<string>();
			this.queue.push({
				type: 'tool_call',
				callId: params.callId,
				toolName: params.tool,
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
		const res = await this.conn.request<TurnStartResult>('turn/start', {
			threadId: this.threadId,
			input: { type: 'text', text: userText },
		});
		logger.debug(`BridgeSession: turn started turnId=${res.turnId}`);

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
