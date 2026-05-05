/**
 * OpenAI Responses Anthropic Bridge — HTTP Server
 *
 * Exposes a small Anthropic-compatible Messages API surface backed directly by
 * OpenAI's Responses API. The Anthropic Agent SDK remains the only local
 * harness: tools are translated to OpenAI function tools and function calls are
 * translated back to Anthropic tool_use blocks for the SDK to execute.
 */

import {
	type AnthropicContentBlock,
	type AnthropicContentBlockToolResult,
	type AnthropicRequest,
	type AnthropicTool,
	type ToolChoice,
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	contentBlockStopSSE,
	errorSSE,
	extractSystemText,
	inputJsonDeltaSSE,
	messageDeltaSSE,
	messageStartSSE,
	messageStopSSE,
	textDeltaSSE,
} from '../codex-anthropic-bridge/translator.js';
import { estimateAnthropicInputTokens } from '../codex-anthropic-bridge/token-estimator.js';
import { getModelContextWindow as getCodexModelContextWindow } from '../codex-anthropic-bridge/model-context-windows.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import { Logger } from '../../logger.js';

const logger = new Logger('openai-responses-bridge-server');

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_RESPONSE_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const SESSION_ROUTE_PREFIX = '/_neokai/session/';

export type OpenAIResponsesBridgeAuth = {
	apiKey: string;
	source: 'api_key' | 'chatgpt_oauth';
	accountId?: string;
	isFedrampAccount?: boolean;
	refreshAuthTokens?: () => Promise<{
		accessToken: string;
		accountId: string;
		isFedrampAccount?: boolean;
	} | null>;
};

export type OpenAIResponsesBridgeModel = {
	id: string;
	display_name: string;
	created_at: string;
	context_window: number;
	max_tokens?: number;
};

export type OpenAIResponsesBridgeServer = {
	port: number;
	baseUrlForSession?(sessionId: string): string;
	stop(): void;
};

export type OpenAIResponsesBridgeConfig = {
	auth: OpenAIResponsesBridgeAuth;
	models: OpenAIResponsesBridgeModel[];
	modelAliases?: Record<string, string>;
	openAIBaseUrl?: string;
	continuationTtlMs?: number;
	fetchImpl?: typeof fetch;
};

type ResponsesInputItem =
	| {
			type: 'message';
			role: 'user' | 'system' | 'developer';
			content: Array<{ type: 'input_text'; text: string }>;
	  }
	| {
			type: 'message';
			role: 'assistant';
			content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
	  }
	| {
			type: 'function_call';
			call_id: string;
			name: string;
			arguments: string;
			status?: 'completed';
	  }
	| {
			type: 'function_call_output';
			call_id: string;
			output: string;
	  };

type ResponsesTool = {
	type: 'function';
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
};

type ResponsesRequest = {
	model: string;
	instructions?: string;
	input: ResponsesInputItem[];
	previous_response_id?: string;
	tools?: ResponsesTool[];
	tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
	max_output_tokens?: number;
	store: false;
	stream: true;
	parallel_tool_calls?: false;
};

type OpenAIStreamEvent = {
	type?: string;
	response?: Record<string, unknown>;
	delta?: string;
	arguments?: string;
	call_id?: string;
	name?: string;
	item?: Record<string, unknown>;
	error?: { message?: string; type?: string; code?: string };
};

type ResolvedResponsesAuth = {
	apiKey: string;
	accountId?: string;
	isFedrampAccount?: boolean;
};

type ResponseContinuation = {
	responseId: string;
	cleanupTimer: ReturnType<typeof setTimeout>;
};

/**
 * Resolve the context window for a model.
 * Prefers the config-provided context window (from bridge models list, which may
 * include non-Codex models like OpenRouter models with 1M+ context), falling back
 * to the Codex-only static lookup for backward compatibility.
 */
function resolveContextWindow(model: string, configContextWindow?: number): number | undefined {
	return configContextWindow ?? getCodexModelContextWindow(model);
}

function generateMsgId(): string {
	return `msg_${Math.random().toString(36).slice(2, 14)}`;
}

function extractSessionId(req: Request): { sessionId: string; pathname: string } {
	const url = new URL(req.url);
	if (url.pathname.startsWith(SESSION_ROUTE_PREFIX)) {
		const remainder = url.pathname.slice(SESSION_ROUTE_PREFIX.length);
		const slashIndex = remainder.indexOf('/');
		if (slashIndex > 0) {
			const encodedSessionId = remainder.slice(0, slashIndex);
			try {
				return {
					sessionId: decodeURIComponent(encodedSessionId),
					pathname: remainder.slice(slashIndex) || '/',
				};
			} catch {
				// Fall back to legacy auth-header parsing below for malformed route IDs.
			}
		}
	}

	const auth =
		req.headers.get('Authorization') ??
		req.headers.get('authorization') ??
		req.headers.get('x-api-key') ??
		'';
	const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : auth;
	if (token.startsWith('codex-bridge-')) {
		return { sessionId: token.slice('codex-bridge-'.length), pathname: url.pathname };
	}
	return { sessionId: 'default', pathname: url.pathname };
}

function continuationKey(sessionId: string, callId: string): string {
	return `${sessionId}\u0000${callId}`;
}

function sendJsonError(status: number, type: AnthropicErrorType, message: string): Response {
	return new Response(createAnthropicErrorBody(type, message), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function mapOpenAIStatusToAnthropicError(status: number): AnthropicErrorType {
	if (status === 401) return 'authentication_error';
	if (status === 403) return 'permission_error';
	if (status === 404) return 'not_found_error';
	if (status === 413) return 'request_too_large';
	if (status === 429) return 'rate_limit_error';
	if (status >= 500) return 'api_error';
	return 'invalid_request_error';
}

function stableStringify(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function estimateTextTokens(text: string): number {
	if (text.length === 0) return 0;

	const characterEstimate = Math.ceil(text.length / 4);
	const lexicalPieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;

	return Math.max(1, Math.ceil((characterEstimate + lexicalPieces) / 2));
}

function estimateResponsesContentTokens(item: ResponsesInputItem): number {
	if (item.type === 'function_call_output') {
		return estimateTextTokens(item.output);
	}
	if (item.type === 'function_call') {
		return estimateTextTokens(item.name) + estimateTextTokens(item.arguments);
	}
	return item.content.reduce((sum, block) => sum + estimateTextTokens(block.text), 0);
}

function estimateResponsesInputTokens(items: ResponsesInputItem[]): number {
	const requestOverheadTokens = 3;
	const itemOverheadTokens = 4;
	return (
		requestOverheadTokens +
		items.reduce((sum, item) => sum + itemOverheadTokens + estimateResponsesContentTokens(item), 0)
	);
}

function estimateResponsesToolTokens(tool: ResponsesTool): number {
	const toolOverheadTokens = 8;
	return (
		toolOverheadTokens +
		estimateTextTokens(tool.name) +
		(tool.description ? estimateTextTokens(tool.description) : 0) +
		estimateTextTokens(stableStringify(tool.parameters))
	);
}

function estimateResponsesPayloadTokens(
	body: AnthropicRequest,
	input: ResponsesInputItem[]
): number {
	const instructions = extractSystemText(body.system);
	const tools = toolsToResponsesTools(body.tools);
	const toolsOverheadTokens = tools && tools.length > 0 ? 4 : 0;
	return (
		estimateResponsesInputTokens(input) +
		(instructions ? estimateTextTokens(instructions) : 0) +
		toolsOverheadTokens +
		(tools?.reduce((sum, tool) => sum + estimateResponsesToolTokens(tool), 0) ?? 0)
	);
}

function toolResultText(content: AnthropicContentBlockToolResult['content']): string {
	if (typeof content === 'string') return content;
	return content.map((block) => block.text).join('\n');
}

function appendInputMessage(
	items: ResponsesInputItem[],
	role: 'user' | 'system' | 'developer',
	textParts: string[]
): void {
	const text = textParts.filter(Boolean).join('\n\n');
	if (!text) return;
	items.push({
		type: 'message',
		role,
		content: [{ type: 'input_text', text }],
	});
}

function appendAssistantMessage(items: ResponsesInputItem[], textParts: string[]): void {
	const text = textParts.filter(Boolean).join('\n\n');
	if (!text) return;
	items.push({
		type: 'message',
		role: 'assistant',
		content: [{ type: 'output_text', text, annotations: [] }],
	});
}

function appendUserBlocks(items: ResponsesInputItem[], blocks: AnthropicContentBlock[]): void {
	const textParts: string[] = [];
	for (const block of blocks) {
		if (block.type === 'text') {
			textParts.push(block.text);
			continue;
		}
		if (block.type === 'tool_result') {
			const result = block as AnthropicContentBlockToolResult & { is_error?: boolean };
			const output = toolResultText(result.content);
			appendInputMessage(items, 'user', textParts.splice(0));
			items.push({
				type: 'function_call_output',
				call_id: result.tool_use_id,
				output: result.is_error ? `[Tool error]\n${output}` : output,
			});
		}
	}
	appendInputMessage(items, 'user', textParts);
}

function appendAssistantBlocks(items: ResponsesInputItem[], blocks: AnthropicContentBlock[]): void {
	const textParts: string[] = [];
	for (const block of blocks) {
		if (block.type === 'text') {
			textParts.push(block.text);
			continue;
		}
		if (block.type === 'tool_use') {
			appendAssistantMessage(items, textParts.splice(0));
			items.push({
				type: 'function_call',
				call_id: block.id,
				name: block.name,
				arguments: stableStringify(block.input),
				status: 'completed',
			});
		}
	}
	appendAssistantMessage(items, textParts);
}

function latestContinuationInputItems(
	messages: AnthropicRequest['messages']
): ResponsesInputItem[] {
	const last = messages.at(-1);
	if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
	if (!last.content.some((block) => block.type === 'tool_result')) return [];

	const items: ResponsesInputItem[] = [];
	appendUserBlocks(items, last.content);
	return items;
}

function resolveContinuation(
	sessionId: string,
	messages: AnthropicRequest['messages'],
	continuations: Map<string, ResponseContinuation>
): { previousResponseId: string; input: ResponsesInputItem[]; callIds: string[] } | undefined {
	const input = latestContinuationInputItems(messages);
	if (input.length === 0) return undefined;

	let previousResponseId: string | undefined;
	const callIds: string[] = [];
	for (const item of input) {
		if (item.type !== 'function_call_output') continue;
		const continuation = continuations.get(continuationKey(sessionId, item.call_id));
		if (!continuation) return undefined;
		callIds.push(item.call_id);
		if (!previousResponseId) {
			previousResponseId = continuation.responseId;
			continue;
		}
		if (previousResponseId !== continuation.responseId) return undefined;
	}

	return previousResponseId ? { previousResponseId, input, callIds } : undefined;
}

export function anthropicMessagesToResponsesInput(
	messages: AnthropicRequest['messages']
): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	for (const message of messages) {
		if (typeof message.content === 'string') {
			if (message.role === 'assistant') {
				appendAssistantMessage(items, [message.content]);
			} else {
				appendInputMessage(items, 'user', [message.content]);
			}
			continue;
		}
		if (message.role === 'assistant') {
			appendAssistantBlocks(items, message.content);
		} else {
			appendUserBlocks(items, message.content);
		}
	}
	return items;
}

function toolsToResponsesTools(tools: AnthropicTool[] | undefined): ResponsesTool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: 'function',
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		parameters: tool.input_schema,
	}));
}

function toolChoiceToResponsesToolChoice(
	toolChoice: ToolChoice | undefined
): ResponsesRequest['tool_choice'] {
	if (!toolChoice) return undefined;
	if (toolChoice.type === 'auto') return 'auto';
	if (toolChoice.type === 'none') return 'none';
	if (toolChoice.type === 'any') return 'required';
	if (toolChoice.type === 'tool') return { type: 'function', name: toolChoice.name };
	return undefined;
}

function buildResponsesRequest(
	body: AnthropicRequest,
	model: string,
	continuation?: { previousResponseId: string; input: ResponsesInputItem[] },
	options: { includeMaxOutputTokens?: boolean; includeParallelToolCalls?: boolean } = {}
): ResponsesRequest {
	const instructions = extractSystemText(body.system) || undefined;
	const tools = toolsToResponsesTools(body.tools);
	const tool_choice = toolChoiceToResponsesToolChoice(body.tool_choice);
	const includeMaxOutputTokens = options.includeMaxOutputTokens ?? true;
	const includeParallelToolCalls = options.includeParallelToolCalls ?? true;
	return {
		model,
		...(instructions ? { instructions } : {}),
		input: continuation?.input ?? anthropicMessagesToResponsesInput(body.messages),
		...(continuation ? { previous_response_id: continuation.previousResponseId } : {}),
		...(tools ? { tools } : {}),
		...(tool_choice ? { tool_choice } : {}),
		...(includeMaxOutputTokens && typeof body.max_tokens === 'number'
			? { max_output_tokens: body.max_tokens }
			: {}),
		store: false,
		stream: true,
		...(includeParallelToolCalls ? { parallel_tool_calls: false } : {}),
	};
}

function defaultBaseUrlForAuth(auth: OpenAIResponsesBridgeAuth): string {
	return auth.source === 'chatgpt_oauth' ? DEFAULT_CHATGPT_CODEX_BASE_URL : DEFAULT_OPENAI_BASE_URL;
}

function buildOpenAIHeaders(
	auth: OpenAIResponsesBridgeAuth,
	resolvedAuth?: ResolvedResponsesAuth
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${resolvedAuth?.apiKey ?? auth.apiKey}`,
		'Content-Type': 'application/json',
	};
	if (auth.source === 'chatgpt_oauth') {
		const accountId = resolvedAuth?.accountId ?? auth.accountId;
		if (accountId) {
			// Matches Codex's BearerAuthProvider for ChatGPT-backed Codex requests.
			headers['ChatGPT-Account-ID'] = accountId;
		}
		if (resolvedAuth?.isFedrampAccount ?? auth.isFedrampAccount) {
			headers['X-OpenAI-Fedramp'] = 'true';
		}
	}
	return headers;
}

async function refreshOpenAIResponsesAuth(
	auth: OpenAIResponsesBridgeAuth
): Promise<ResolvedResponsesAuth | null> {
	if (auth.source !== 'chatgpt_oauth' || !auth.refreshAuthTokens) return null;
	const refreshed = await auth.refreshAuthTokens();
	if (!refreshed) return null;
	return {
		apiKey: refreshed.accessToken,
		accountId: refreshed.accountId,
		isFedrampAccount: refreshed.isFedrampAccount,
	};
}

function readUsageNumber(record: Record<string, unknown> | undefined, key: string): number | null {
	const value = record?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFirstUsageNumber(
	record: Record<string, unknown> | undefined,
	keys: string[]
): number | null {
	for (const key of keys) {
		const value = readUsageNumber(record, key);
		if (value !== null) return value;
	}
	return null;
}

function responseUsage(response: Record<string, unknown> | undefined): {
	inputTokens?: number | null;
	outputTokens: number;
} {
	const usage = response?.usage;
	const usageRecord =
		usage && typeof usage === 'object' && !Array.isArray(usage)
			? (usage as Record<string, unknown>)
			: undefined;
	return {
		inputTokens: readFirstUsageNumber(usageRecord, [
			'input_tokens',
			'prompt_tokens',
			'inputTokens',
		]),
		outputTokens:
			readFirstUsageNumber(usageRecord, ['output_tokens', 'completion_tokens', 'outputTokens']) ??
			0,
	};
}

function streamErrorMessage(event: OpenAIStreamEvent): string {
	if (typeof event.error?.message === 'string') return event.error.message;
	const responseError = event.response?.error;
	if (responseError && typeof responseError === 'object' && !Array.isArray(responseError)) {
		const message = (responseError as Record<string, unknown>).message;
		if (typeof message === 'string') return message;
	}
	return 'OpenAI Responses API error';
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseOpenAIError(status: number, text: string): string {
	const parsed = parseJsonObject(text);
	const error = parsed?.error;
	if (error && typeof error === 'object' && !Array.isArray(error)) {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === 'string' && message) return message;
	}
	return text || `OpenAI API request failed with status ${status}`;
}

function parseSSEBlock(block: string): OpenAIStreamEvent | null {
	let eventType = '';
	const dataLines: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith('event:')) {
			eventType = line.slice('event:'.length).trim();
		} else if (line.startsWith('data:')) {
			dataLines.push(line.slice('data:'.length).trimStart());
		}
	}
	const data = dataLines.join('\n');
	if (!data || data === '[DONE]') return null;
	const parsed = parseJsonObject(data);
	if (!parsed) return null;
	return { type: eventType || (parsed.type as string | undefined), ...parsed };
}

async function* readOpenAIStream(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split(/\r?\n\r?\n/);
		buffer = blocks.pop() ?? '';
		for (const block of blocks) {
			const event = parseSSEBlock(block);
			if (event) yield event;
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) {
		const event = parseSSEBlock(buffer);
		if (event) yield event;
	}
}

type PendingFunctionCall = {
	callId: string;
	name: string;
	argumentsText: string;
};

function functionCallFromEvent(event: OpenAIStreamEvent): PendingFunctionCall | null {
	if (event.type === 'response.function_call_arguments.done') {
		if (typeof event.call_id !== 'string' || typeof event.name !== 'string') return null;
		return {
			callId: event.call_id,
			name: event.name,
			argumentsText: typeof event.arguments === 'string' ? event.arguments : '{}',
		};
	}

	const item = event.item;
	if (
		event.type === 'response.output_item.done' &&
		item?.type === 'function_call' &&
		typeof item.call_id === 'string' &&
		typeof item.name === 'string'
	) {
		return {
			callId: item.call_id,
			name: item.name,
			argumentsText: typeof item.arguments === 'string' ? item.arguments : '{}',
		};
	}

	return null;
}

function isControllerInvalidStateError(err: unknown): boolean {
	return (
		err instanceof TypeError &&
		((err as { code?: string }).code === 'ERR_INVALID_STATE' ||
			err.message.includes('Controller is already closed'))
	);
}

async function streamResponsesToAnthropic({
	openAIResponse,
	controller,
	model,
	estimatedInputTokens,
	onFunctionCallResponse,
	modelContextWindow,
}: {
	openAIResponse: Response;
	controller: ReadableStreamDefaultController<Uint8Array>;
	model: string;
	estimatedInputTokens: number;
	onFunctionCallResponse?: (callId: string, responseId: string) => void;
	/**
	 * Context window for the active model, resolved from the bridge config's models
	 * list at session creation time. Takes precedence over the Codex-only
	 * `getModelContextWindow()` lookup so that non-Codex models (e.g. OpenRouter
	 * models with large context windows) are reported correctly to the SDK.
	 */
	modelContextWindow?: number;
}): Promise<void> {
	const enc = new TextEncoder();
	let closed = false;
	const send = (chunk: string): boolean => {
		if (closed) return false;
		try {
			controller.enqueue(enc.encode(chunk));
			return true;
		} catch (err) {
			if (isControllerInvalidStateError(err)) {
				closed = true;
				logger.warn('openai-responses: SSE controller was already closed while sending');
				return false;
			}
			throw err;
		}
	};
	const closeController = (): void => {
		if (closed) return;
		closed = true;
		try {
			controller.close();
		} catch (err) {
			if (!isControllerInvalidStateError(err)) throw err;
			logger.warn('openai-responses: SSE controller was already closed while closing');
		}
	};
	const messageId = generateMsgId();
	let started = false;
	let textOpen = false;
	let blockIndex = 0;
	let heuristicOutputTokens = 0;
	let completedUsage: { inputTokens?: number | null; outputTokens: number } | null = null;
	let incomplete = false;
	const emittedFunctionCalls = new Set<string>();

	const ensureStarted = (): boolean => {
		if (started) return !closed;
		started = true;
		return send(
			messageStartSSE(
				messageId,
				model,
				estimatedInputTokens,
				resolveContextWindow(model, modelContextWindow)
			)
		);
	};

	const closeTextBlock = () => {
		if (!textOpen) return;
		if (!send(contentBlockStopSSE(blockIndex))) return;
		blockIndex++;
		textOpen = false;
	};

	const emitFunctionCall = (call: PendingFunctionCall) => {
		if (emittedFunctionCalls.has(call.callId)) return;
		if (!ensureStarted()) return;
		closeTextBlock();
		if (!send(contentBlockStartToolUseSSE(blockIndex, call.callId, call.name))) return;
		if (!send(inputJsonDeltaSSE(blockIndex, call.argumentsText || '{}'))) return;
		if (!send(contentBlockStopSSE(blockIndex))) return;
		blockIndex++;
		emittedFunctionCalls.add(call.callId);
	};

	try {
		if (!openAIResponse.body) {
			throw new Error('OpenAI API returned an empty streaming body');
		}

		for await (const event of readOpenAIStream(openAIResponse.body)) {
			if (event.type === 'response.output_text.delta') {
				ensureStarted();
				if (!textOpen) {
					send(contentBlockStartTextSSE(blockIndex));
					textOpen = true;
				}
				const delta = typeof event.delta === 'string' ? event.delta : '';
				if (delta) {
					send(textDeltaSSE(blockIndex, delta));
					heuristicOutputTokens += Math.max(1, Math.ceil(delta.length / 4));
				}
				continue;
			}

			const call = functionCallFromEvent(event);
			if (call) {
				emitFunctionCall(call);
				continue;
			}

			if (event.type === 'response.completed') {
				completedUsage = responseUsage(event.response);
				const responseId = typeof event.response?.id === 'string' ? event.response.id : undefined;
				const output = event.response?.output;
				if (Array.isArray(output)) {
					for (const item of output) {
						if (
							item &&
							typeof item === 'object' &&
							(item as Record<string, unknown>).type === 'function_call'
						) {
							const record = item as Record<string, unknown>;
							if (typeof record.call_id === 'string' && typeof record.name === 'string') {
								emitFunctionCall({
									callId: record.call_id,
									name: record.name,
									argumentsText: typeof record.arguments === 'string' ? record.arguments : '{}',
								});
							}
						}
					}
				}
				if (responseId) {
					for (const callId of emittedFunctionCalls) {
						onFunctionCallResponse?.(callId, responseId);
					}
				}
				continue;
			}

			if (event.type === 'response.incomplete') {
				incomplete = true;
				completedUsage = responseUsage(event.response);
				continue;
			}

			if (event.type === 'response.failed' || event.type === 'error') {
				ensureStarted();
				closeTextBlock();
				send(errorSSE('api_error', streamErrorMessage(event)));
				send(messageStopSSE());
				closeController();
				return;
			}
		}

		ensureStarted();
		closeTextBlock();
		// If the model emitted tool calls before an incomplete event, let the SDK execute
		// them; the follow-up turn can carry the continuation forward.
		const stopReason =
			emittedFunctionCalls.size > 0 ? 'tool_use' : incomplete ? 'max_tokens' : 'end_turn';
		send(
			messageDeltaSSE(stopReason, {
				inputTokens: completedUsage?.inputTokens ?? estimatedInputTokens,
				outputTokens: completedUsage?.outputTokens || heuristicOutputTokens,
				modelContextWindow: resolveContextWindow(model, modelContextWindow),
			})
		);
		send(messageStopSSE());
		closeController();
	} catch (err) {
		if (isControllerInvalidStateError(err)) {
			closed = true;
			logger.warn('openai-responses: SSE controller closed during streaming');
			return;
		}
		logger.error('openai-responses: streaming failed:', err);
		try {
			ensureStarted();
			closeTextBlock();
			send(errorSSE('api_error', err instanceof Error ? err.message : 'OpenAI streaming failed'));
			send(messageStopSSE());
		} finally {
			closeController();
		}
	}
}

export const _openAIResponsesBridgeServerTesting = {
	streamResponsesToAnthropic,
};

function modelsListResponse(models: OpenAIResponsesBridgeModel[]): object {
	const data = models.map((model) => {
		const autoCompactTokenLimit = Math.floor(model.context_window * 0.9);
		return {
			id: model.id,
			type: 'model',
			display_name: model.display_name,
			created_at: model.created_at,
			max_input_tokens: model.context_window,
			context_window: model.context_window,
			max_context_window: model.context_window,
			model_context_window: model.context_window,
			auto_compact_token_limit: autoCompactTokenLimit,
			model_auto_compact_token_limit: autoCompactTokenLimit,
			max_tokens: model.max_tokens ?? 16384,
		};
	});
	return {
		data,
		has_more: false,
		first_id: data[0]?.id ?? null,
		last_id: data.at(-1)?.id ?? null,
	};
}

function resolveModelId(model: string, aliases: Record<string, string> | undefined): string {
	return aliases?.[model] ?? model;
}

export function createOpenAIResponsesBridgeServer(
	config: OpenAIResponsesBridgeConfig
): OpenAIResponsesBridgeServer {
	const fetchImpl = config.fetchImpl ?? fetch;
	const baseUrl = config.openAIBaseUrl ?? defaultBaseUrlForAuth(config.auth);
	const modelsResponse = modelsListResponse(config.models);
	// Build a model ID → context_window lookup from the bridge config's models
	// list. This includes both Codex models and any non-Codex models passed at
	// bridge creation time (e.g. OpenRouter models with 1M+ context). The lookup
	// is used by the streaming path to report the correct context window to the SDK
	// instead of falling back to the Codex-only getModelContextWindow().
	const contextWindowByModelId = new Map<string, number>();
	for (const model of config.models) {
		contextWindowByModelId.set(model.id, model.context_window);
	}
	// Also index by aliases so that resolved alias → context_window works.
	if (config.modelAliases) {
		for (const [alias, modelId] of Object.entries(config.modelAliases)) {
			const cw = contextWindowByModelId.get(modelId);
			if (cw !== undefined) {
				contextWindowByModelId.set(alias, cw);
			}
		}
	}
	const continuationTtlMs = config.continuationTtlMs ?? DEFAULT_RESPONSE_CONTINUATION_TTL_MS;
	const continuations = new Map<string, ResponseContinuation>();
	let resolvedAuth: ResolvedResponsesAuth | undefined;
	// ChatGPT Codex endpoint rejects max_output_tokens and parallel_tool_calls.
	const isChatgptOAuth = config.auth.source === 'chatgpt_oauth' && !config.openAIBaseUrl;
	const buildOpts = {
		includeMaxOutputTokens: !isChatgptOAuth,
		includeParallelToolCalls: !isChatgptOAuth,
	};

	const deleteContinuation = (sessionId: string, callId: string): void => {
		const key = continuationKey(sessionId, callId);
		const continuation = continuations.get(key);
		if (!continuation) return;
		clearTimeout(continuation.cleanupTimer);
		continuations.delete(key);
	};

	const storeContinuation = (sessionId: string, callId: string, responseId: string): void => {
		deleteContinuation(sessionId, callId);
		const key = continuationKey(sessionId, callId);
		const cleanupTimer = setTimeout(() => {
			logger.warn(
				`openai-responses: continuation TTL expired sessionId=${sessionId} callId=${callId}`
			);
			continuations.delete(key);
		}, continuationTtlMs);
		continuations.set(key, { responseId, cleanupTimer });
	};

	const consumeContinuation = (
		sessionId: string,
		continuation:
			| { previousResponseId: string; input: ResponsesInputItem[]; callIds: string[] }
			| undefined
	): void => {
		for (const callId of continuation?.callIds ?? []) {
			deleteContinuation(sessionId, callId);
		}
	};

	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req: Request): Promise<Response> {
			const route = extractSessionId(req);

			if (route.pathname === '/health' || route.pathname === '/v1/health') {
				return new Response('ok');
			}

			if (route.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(JSON.stringify(modelsResponse), {
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (route.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
				try {
					const body = (await req.json()) as AnthropicRequest;
					const continuation = resolveContinuation(route.sessionId, body.messages, continuations);
					const inputTokens = continuation
						? estimateResponsesPayloadTokens(body, continuation.input)
						: estimateAnthropicInputTokens(body);
					return new Response(JSON.stringify({ input_tokens: inputTokens }), {
						headers: { 'Content-Type': 'application/json' },
					});
				} catch {
					return sendJsonError(400, 'invalid_request_error', 'Bad Request');
				}
			}

			if (route.pathname !== '/v1/messages' || req.method !== 'POST') {
				return sendJsonError(501, 'api_error', 'Not implemented');
			}

			let body: AnthropicRequest;
			try {
				body = (await req.json()) as AnthropicRequest;
			} catch {
				return sendJsonError(400, 'invalid_request_error', 'Bad Request: invalid JSON');
			}

			if (!body.model || !Array.isArray(body.messages)) {
				return sendJsonError(
					400,
					'invalid_request_error',
					'Missing required fields: model and messages'
				);
			}
			if (body.stream === false) {
				return sendJsonError(
					400,
					'invalid_request_error',
					'Only streaming responses are supported'
				);
			}

			const model = resolveModelId(body.model, config.modelAliases);
			const sessionId = route.sessionId;
			const resolvedContinuation = isChatgptOAuth
				? undefined
				: resolveContinuation(sessionId, body.messages, continuations);
			let continuation = resolvedContinuation;
			const requestBody = buildResponsesRequest(body, model, continuation, buildOpts);
			const upstreamUrl = `${baseUrl.replace(/\/$/, '')}/responses`;
			let openAIResponse: Response;
			try {
				openAIResponse = await fetchImpl(upstreamUrl, {
					method: 'POST',
					headers: buildOpenAIHeaders(config.auth, resolvedAuth),
					body: JSON.stringify(requestBody),
				});
				if (openAIResponse.status === 401) {
					const refreshed = await refreshOpenAIResponsesAuth(config.auth);
					if (refreshed) {
						resolvedAuth = refreshed;
						openAIResponse = await fetchImpl(upstreamUrl, {
							method: 'POST',
							headers: buildOpenAIHeaders(config.auth, resolvedAuth),
							body: JSON.stringify(requestBody),
						});
					}
				}
				if (continuation && !openAIResponse.ok && openAIResponse.status === 400) {
					const errorText = await openAIResponse.text();
					if (errorText.includes('previous_response_id')) {
						logger.warn(
							'openai-responses: endpoint rejects previous_response_id, retrying with full history'
						);
						openAIResponse = await fetchImpl(upstreamUrl, {
							method: 'POST',
							headers: buildOpenAIHeaders(config.auth, resolvedAuth),
							body: JSON.stringify(buildResponsesRequest(body, model, undefined, buildOpts)),
						});
						continuation = undefined;
					} else {
						return sendJsonError(
							openAIResponse.status,
							mapOpenAIStatusToAnthropicError(openAIResponse.status),
							parseOpenAIError(openAIResponse.status, errorText)
						);
					}
				}
			} catch (err) {
				logger.warn('openai-responses: upstream request failed:', err);
				return sendJsonError(
					502,
					'api_error',
					err instanceof Error ? err.message : 'OpenAI API request failed'
				);
			}

			if (!openAIResponse.ok) {
				const text = await openAIResponse.text();
				return sendJsonError(
					openAIResponse.status,
					mapOpenAIStatusToAnthropicError(openAIResponse.status),
					parseOpenAIError(openAIResponse.status, text)
				);
			}
			consumeContinuation(sessionId, resolvedContinuation);

			const estimatedInputTokens = continuation
				? estimateResponsesPayloadTokens(body, continuation.input)
				: estimateAnthropicInputTokens(body);
			const resolvedModelContextWindow = contextWindowByModelId.get(model);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					// Each HTTP request creates its own ReadableStream controller. SDK-level retries issue
					// a new /v1/messages request, so a timed-out request cannot reuse an aborted controller.
					void streamResponsesToAnthropic({
						openAIResponse,
						controller,
						model,
						estimatedInputTokens,
						...(resolvedModelContextWindow !== undefined
							? { modelContextWindow: resolvedModelContextWindow }
							: {}),
						...(isChatgptOAuth
							? {}
							: {
									onFunctionCallResponse(callId: string, responseId: string) {
										storeContinuation(sessionId, callId, responseId);
									},
								}),
					});
				},
			});
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
			});
		},
	});

	const port = server.port;
	if (typeof port !== 'number') {
		throw new Error('OpenAI Responses bridge server did not bind to a TCP port');
	}

	logger.info(`openai-responses: HTTP server listening on port ${port}`);
	return {
		port,
		baseUrlForSession: (sessionId: string) =>
			`http://127.0.0.1:${port}${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`,
		stop: () => {
			for (const continuation of continuations.values()) {
				clearTimeout(continuation.cleanupTimer);
			}
			continuations.clear();
			server.stop(true);
		},
	};
}
