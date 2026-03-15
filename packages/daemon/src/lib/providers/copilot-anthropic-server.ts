/**
 * Embedded Anthropic-compatible HTTP server for GitHub Copilot
 *
 * Starts a loopback HTTP server that speaks the Anthropic messages API
 * (`POST /v1/messages`). The Claude Agent SDK can point its `ANTHROPIC_BASE_URL`
 * at this server and use GitHub Copilot as a backend natively, without any
 * custom generator bridging.
 *
 * Adapted from https://github.com/theblixguy/copilot-sdk-proxy (MIT) — the
 * Anthropic provider path only, rewritten for Node.js `http` (no Fastify) and
 * integrated with NeoKai's existing `CopilotClient` singleton.
 *
 * ## Request flow
 *
 * 1. Claude Agent SDK sends `POST /v1/messages` (Anthropic wire format)
 * 2. Server validates and extracts messages + system prompt
 * 3. Creates or reuses a `CopilotSession` (primary-conversation pattern)
 * 4. Formats messages as flat `[User]: …` / `[Assistant]: …` prompt string
 * 5. Calls `session.send({ prompt })` and streams Anthropic SSE back
 *
 * ## Conversation management
 *
 * One *primary* conversation is kept alive across requests for multi-turn
 * context. If the primary is busy, an isolated single-use conversation is
 * created instead. On session error the primary is cleared so the next
 * request gets a fresh session.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
	CopilotClient,
	CopilotSession,
	SessionEvent,
	SessionConfig,
} from '@github/copilot-sdk';
import { Logger } from '../logger.js';

const logger = new Logger('copilot-anthropic-server');

// ---------------------------------------------------------------------------
// Conversation management (adapted from copilot-sdk-proxy/conversation-manager)
// ---------------------------------------------------------------------------

interface Conversation {
	id: string;
	session: CopilotSession | null;
	/** Number of messages sent so far (for incremental prompting) */
	sentMessageCount: number;
	isPrimary: boolean;
	sessionActive: boolean;
}

class ConversationManager {
	private readonly conversations = new Map<string, Conversation>();
	private primaryId: string | null = null;

	private create(isPrimary = false): Conversation {
		const id = randomUUID();
		const conv: Conversation = {
			id,
			session: null,
			sentMessageCount: 0,
			isPrimary,
			sessionActive: false,
		};
		this.conversations.set(id, conv);
		if (isPrimary) this.primaryId = id;
		return conv;
	}

	findForNewRequest(): { conversation: Conversation; isReuse: boolean } {
		// Evict finished isolated conversations to prevent unbounded growth
		for (const [id, conv] of this.conversations) {
			if (!conv.isPrimary && !conv.sessionActive) {
				this.conversations.delete(id);
			}
		}

		const primary = this.primaryId ? (this.conversations.get(this.primaryId) ?? null) : null;
		if (primary) {
			if (primary.sessionActive || !primary.session) {
				// Primary is busy — spin up a single-use isolated conversation
				return { conversation: this.create(), isReuse: false };
			}
			return { conversation: primary, isReuse: true };
		}
		return { conversation: this.create(true), isReuse: false };
	}

	remove(id: string): void {
		if (this.conversations.get(id)?.isPrimary) this.primaryId = null;
		this.conversations.delete(id);
	}

	clearPrimary(): void {
		if (this.primaryId) {
			this.conversations.delete(this.primaryId);
			this.primaryId = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Anthropic message types (inline — no external schema dep)
// ---------------------------------------------------------------------------

interface TextBlock {
	type: 'text';
	text: string;
}
interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}
interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content?: string | TextBlock[];
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string | TextBlock[];
	stream?: boolean;
}

// ---------------------------------------------------------------------------
// Prompt formatter (adapted from copilot-sdk-proxy/claude/prompt.ts)
// ---------------------------------------------------------------------------

function extractToolResultText(content: string | TextBlock[] | undefined): string {
	if (content == null) return '';
	if (typeof content === 'string') return content;
	return content.map((b) => b.text).join('');
}

function formatBlocks(blocks: ContentBlock[], role: 'user' | 'assistant', parts: string[]): void {
	for (const block of blocks) {
		if (block.type === 'text') {
			if (!block.text) continue;
			parts.push(role === 'user' ? `[User]: ${block.text}` : `[Assistant]: ${block.text}`);
		} else if (block.type === 'tool_use') {
			parts.push(`[Assistant called tool ${block.name} with args: ${JSON.stringify(block.input)}]`);
		} else if (block.type === 'tool_result') {
			parts.push(`[Tool result for ${block.tool_use_id}]: ${extractToolResultText(block.content)}`);
		}
	}
}

function formatAnthropicPrompt(messages: AnthropicMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			parts.push(msg.role === 'user' ? `[User]: ${msg.content}` : `[Assistant]: ${msg.content}`);
		} else {
			formatBlocks(msg.content, msg.role, parts);
		}
	}
	return parts.join('\n\n');
}

function extractSystemText(system: string | TextBlock[] | undefined): string | undefined {
	if (system == null) return undefined;
	if (typeof system === 'string') return system || undefined;
	const text = system.map((b) => b.text).join('\n\n');
	return text || undefined;
}

// ---------------------------------------------------------------------------
// SSE helpers (adapted from copilot-sdk-proxy/shared/streaming-utils.ts)
// ---------------------------------------------------------------------------

const SSE_HEADERS: Record<string, string> = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no',
};

function sendEvent(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Anthropic SSE stream writer (adapted from copilot-sdk-proxy/claude/streaming.ts)
// ---------------------------------------------------------------------------

class AnthropicStreamWriter {
	private textBlockStarted = false;
	private nextBlockIndex = 0;
	private textBlockIndex = 0;

	private closeTextBlock(res: ServerResponse): void {
		if (this.textBlockStarted) {
			sendEvent(res, 'content_block_stop', {
				type: 'content_block_stop',
				index: this.textBlockIndex,
			});
			this.nextBlockIndex = this.textBlockIndex + 1;
			this.textBlockStarted = false;
		}
	}

	private ensureTextBlock(res: ServerResponse): void {
		if (!this.textBlockStarted) {
			this.textBlockIndex = this.nextBlockIndex;
			sendEvent(res, 'content_block_start', {
				type: 'content_block_start',
				index: this.textBlockIndex,
				content_block: { type: 'text', text: '' },
			});
			this.textBlockStarted = true;
		}
	}

	private sendEpilogue(res: ServerResponse, stopReason: string): void {
		sendEvent(res, 'message_delta', {
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 0 },
		});
		sendEvent(res, 'message_stop', { type: 'message_stop' });
	}

	start(res: ServerResponse, model: string): void {
		res.writeHead(200, SSE_HEADERS);
		sendEvent(res, 'message_start', {
			type: 'message_start',
			message: {
				id: `msg_${randomUUID()}`,
				type: 'message',
				role: 'assistant',
				content: [],
				model,
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	flushDeltas(res: ServerResponse, deltas: string[]): void {
		this.ensureTextBlock(res);
		for (const text of deltas) {
			sendEvent(res, 'content_block_delta', {
				type: 'content_block_delta',
				index: this.textBlockIndex,
				delta: { type: 'text_delta', text },
			});
		}
	}

	sendCompleted(res: ServerResponse): void {
		this.ensureTextBlock(res);
		this.closeTextBlock(res);
		this.sendEpilogue(res, 'end_turn');
	}

	sendFailed(res: ServerResponse): void {
		if (this.textBlockStarted) {
			sendEvent(res, 'content_block_stop', {
				type: 'content_block_stop',
				index: this.textBlockIndex,
			});
		}
		this.sendEpilogue(res, 'end_turn');
	}
}

// ---------------------------------------------------------------------------
// Session streaming loop (adapted from copilot-sdk-proxy/shared/streaming-core.ts)
// ---------------------------------------------------------------------------

function runSessionStreaming(
	session: CopilotSession,
	prompt: string,
	model: string,
	res: ServerResponse
): Promise<boolean> {
	const writer = new AnthropicStreamWriter();
	writer.start(res, model);

	let sessionDone = false;
	let pendingDeltas: string[] = [];

	function flushDeltas(): void {
		if (pendingDeltas.length === 0) return;
		writer.flushDeltas(res, pendingDeltas);
		pendingDeltas = [];
	}

	const { promise, resolve } = Promise.withResolvers<boolean>();

	const unsubscribe = session.on((event: SessionEvent) => {
		switch (event.type) {
			case 'assistant.message_delta':
				if (event.data.deltaContent) pendingDeltas.push(event.data.deltaContent);
				break;

			case 'assistant.message':
				flushDeltas();
				break;

			case 'session.idle':
				sessionDone = true;
				flushDeltas();
				writer.sendCompleted(res);
				res.end();
				unsubscribe();
				resolve(true);
				break;

			case 'session.error':
				logger.warn(`Copilot session error: ${event.data.message}`);
				sessionDone = true;
				writer.sendFailed(res);
				res.end();
				unsubscribe();
				resolve(false);
				break;

			default:
				break;
		}
	});

	res.on('close', () => {
		if (!sessionDone) {
			sessionDone = true;
			unsubscribe();
			session.abort().catch(() => {});
			resolve(false);
		}
	});

	session.send({ prompt }).catch((err: unknown) => {
		if (sessionDone) return;
		logger.error('Failed to send prompt to Copilot session:', err);
		sessionDone = true;
		res.end();
		unsubscribe();
		resolve(false);
	});

	return promise;
}

// ---------------------------------------------------------------------------
// HTTP request parsing helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function sendJsonError(
	res: ServerResponse,
	status: number,
	type: 'invalid_request_error' | 'api_error',
	message: string
): void {
	const body = JSON.stringify({ type: 'error', error: { type, message } });
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(body);
}

function isAnthropicRequest(body: unknown): body is AnthropicRequest {
	if (typeof body !== 'object' || body === null) return false;
	const b = body as Record<string, unknown>;
	return (
		typeof b['model'] === 'string' &&
		typeof b['max_tokens'] === 'number' &&
		Array.isArray(b['messages'])
	);
}

// ---------------------------------------------------------------------------
// Session config builder
// ---------------------------------------------------------------------------

function buildSessionConfig(
	model: string,
	systemMessage: string | undefined,
	cwd: string
): SessionConfig {
	return {
		clientName: 'neokai-copilot-anthropic',
		model,
		streaming: true,
		infiniteSessions: { enabled: true },
		workingDirectory: cwd,
		...(systemMessage
			? { systemMessage: { mode: 'replace' as const, content: systemMessage } }
			: {}),

		onUserInputRequest: (_request) =>
			Promise.resolve({
				answer: 'User input is not available. Ask your question in your response instead.',
				wasFreeform: true,
			}),

		onPermissionRequest: (_request) => Promise.resolve({ kind: 'approved' as const }),

		hooks: {
			onPreToolUse: (_input) => Promise.resolve({ permissionDecision: 'allow' as const }),

			onPostToolUse: (_input) => {
				// no-op
			},

			onErrorOccurred: (input) => {
				logger.warn(
					`SDK error (${input.errorContext}, recoverable=${String(input.recoverable)}): ${String(input.error)}`
				);
				if (
					input.recoverable &&
					(input.errorContext === 'model_call' || input.errorContext === 'tool_execution')
				) {
					return { errorHandling: 'retry' as const, retryCount: 2 };
				}
				return undefined;
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleMessages(
	req: IncomingMessage,
	res: ServerResponse,
	client: CopilotClient,
	manager: ConversationManager,
	cwd: string
): Promise<void> {
	let bodyText: string;
	try {
		bodyText = await readBody(req);
	} catch {
		sendJsonError(res, 400, 'invalid_request_error', 'Failed to read request body');
		return;
	}

	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		sendJsonError(res, 400, 'invalid_request_error', 'Request body must be valid JSON');
		return;
	}

	if (!isAnthropicRequest(body)) {
		sendJsonError(
			res,
			400,
			'invalid_request_error',
			'Missing required fields: model, max_tokens, messages'
		);
		return;
	}

	if (body.stream === false) {
		sendJsonError(res, 400, 'invalid_request_error', 'Only streaming responses are supported');
		return;
	}

	const { conversation, isReuse } = manager.findForNewRequest();
	conversation.sessionActive = true;

	logger.debug(
		isReuse ? `Reusing conversation ${conversation.id}` : `New conversation ${conversation.id}`
	);

	let prompt: string;
	try {
		prompt = formatAnthropicPrompt(
			body.messages.slice(isReuse ? conversation.sentMessageCount : 0)
		);
	} catch (err) {
		conversation.sessionActive = false;
		if (!isReuse) manager.remove(conversation.id);
		sendJsonError(
			res,
			400,
			'invalid_request_error',
			err instanceof Error ? err.message : 'Prompt formatting failed'
		);
		return;
	}

	if (!isReuse) {
		const systemMessage = extractSystemText(body.system);
		const sessionConfig = buildSessionConfig(body.model, systemMessage, cwd);

		try {
			conversation.session = await client.createSession(sessionConfig);
		} catch (err) {
			logger.error('Failed to create Copilot session:', err);
			conversation.sessionActive = false;
			manager.remove(conversation.id);
			sendJsonError(res, 500, 'api_error', 'Failed to create session');
			return;
		}
	}

	const session = conversation.session;
	if (!session) {
		logger.error('Conversation has no session, clearing primary');
		manager.clearPrimary();
		conversation.sessionActive = false;
		sendJsonError(res, 500, 'api_error', 'Session lost, please retry');
		return;
	}

	try {
		const healthy = await runSessionStreaming(session, prompt, body.model, res);
		if (healthy) {
			conversation.sentMessageCount = body.messages.length;
		} else {
			if (conversation.isPrimary) manager.clearPrimary();
		}
	} catch (err) {
		logger.error('Streaming failed:', err);
		if (conversation.isPrimary) manager.clearPrimary();
		if (!res.headersSent) {
			sendJsonError(res, 500, 'api_error', err instanceof Error ? err.message : 'Internal error');
		}
	} finally {
		conversation.sessionActive = false;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbeddedServer {
	/** Base URL of the embedded server, e.g. `http://127.0.0.1:PORT` */
	readonly url: string;
	/** Gracefully stop the server */
	stop(): Promise<void>;
}

/**
 * Start an embedded Anthropic-compatible HTTP server backed by a Copilot SDK client.
 *
 * The server listens on a random loopback port (`127.0.0.1:0`). Pass the
 * returned `url` as `ANTHROPIC_BASE_URL` when constructing the Claude Agent SDK
 * query so the SDK routes all API calls through this server.
 *
 * @param client - Initialised `CopilotClient` to create sessions with
 * @param cwd - Working directory for Copilot sessions (default: `process.cwd()`)
 */
export function startEmbeddedServer(
	client: CopilotClient,
	cwd = process.cwd()
): Promise<EmbeddedServer> {
	const manager = new ConversationManager();

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? '';
		const method = req.method ?? '';

		if (method === 'POST' && (url === '/v1/messages' || url.startsWith('/v1/messages?'))) {
			handleMessages(req, res, client, manager, cwd).catch((err: unknown) => {
				logger.error('Unhandled error in handleMessages:', err);
				if (!res.headersSent) {
					sendJsonError(res, 500, 'api_error', 'Internal server error');
				}
			});
			return;
		}

		// Health check
		if (method === 'GET' && url === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Not found' } }));
	});

	return new Promise((resolve, reject) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${addr.port}`;
			logger.debug(`Embedded Anthropic server listening at ${url}`);

			resolve({
				url,
				stop: () =>
					new Promise((res, rej) =>
						server.close((err) => {
							if (err) rej(err);
							else res();
						})
					),
			});
		});

		server.on('error', reject);
	});
}
