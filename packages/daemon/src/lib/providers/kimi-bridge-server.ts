import {
	type AnthropicContentBlockText,
	type AnthropicContentBlockToolResult,
	type AnthropicContentBlockToolUse,
	type AnthropicRequest,
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	contentBlockStopSSE,
	errorSSE,
	inputJsonDeltaSSE,
	messageDeltaSSE,
	messageStartSSE,
	messageStopSSE,
	textDeltaSSE,
} from './codex-anthropic-bridge/translator.js';
import { estimateAnthropicInputTokens } from './codex-anthropic-bridge/token-estimator.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from './shared/error-envelope.js';
import { Logger } from '../logger.js';

const logger = new Logger('kimi-bridge-server');

export type KimiBridgeServer = {
	port: number;
	stop(): void;
};

export type KimiBridgeConfig = {
	baseUrl: string;
	apiKey: string;
	authToken: string;
	fetchImpl?: typeof fetch;
};

type OpenAIChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
};

type OpenAITool = {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
};

type OpenAIToolCall = {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
};

type OpenAIChatRequest = {
	model: string;
	messages: OpenAIChatMessage[];
	tools?: OpenAITool[];
	tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
	max_tokens?: number;
	stream: true;
};

type OpenAIChatChunk = {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: 'function';
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
	error?: { message?: string; type?: string; code?: string };
};

type AccumulatedToolCall = {
	id: string;
	name: string;
	arguments: string;
};

function sendJsonError(status: number, type: AnthropicErrorType, message: string): Response {
	return new Response(createAnthropicErrorBody(type, message), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function mapStatusToAnthropicError(status: number): AnthropicErrorType {
	if (status === 401 || status === 403) return 'authentication_error';
	if (status === 404) return 'not_found_error';
	if (status === 413) return 'request_too_large';
	if (status === 429) return 'rate_limit_error';
	if (status >= 500) return 'api_error';
	return 'invalid_request_error';
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function extractText(content: string | AnthropicRequest['messages'][number]['content']): string {
	if (typeof content === 'string') return content;
	return content
		.filter((block): block is AnthropicContentBlockText => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}

function extractSystemText(system: AnthropicRequest['system'] | undefined): string {
	if (!system) return '';
	if (typeof system === 'string') return system;
	return system.map((block) => block.text).join('\n');
}

function toolResultText(toolResult: AnthropicContentBlockToolResult): string {
	if (typeof toolResult.content === 'string') return toolResult.content;
	return toolResult.content.map((part) => part.text).join('');
}

function toOpenAIToolCall(toolUse: AnthropicContentBlockToolUse): OpenAIToolCall {
	return {
		id: toolUse.id,
		type: 'function',
		function: {
			name: toolUse.name,
			arguments: JSON.stringify(toolUse.input ?? {}),
		},
	};
}

function appendOpenAIMessages(
	messages: OpenAIChatMessage[],
	message: AnthropicRequest['messages'][number]
): void {
	if (typeof message.content === 'string') {
		messages.push({ role: message.role, content: message.content });
		return;
	}

	const text = extractText(message.content);
	const toolUses = message.content.filter(
		(block): block is AnthropicContentBlockToolUse => block.type === 'tool_use'
	);
	if (message.role === 'assistant') {
		messages.push({
			role: 'assistant',
			content: text || null,
			...(toolUses.length > 0 ? { tool_calls: toolUses.map(toOpenAIToolCall) } : {}),
		});
		return;
	}

	const toolResults = message.content.filter(
		(block): block is AnthropicContentBlockToolResult => block.type === 'tool_result'
	);
	for (const result of toolResults) {
		messages.push({
			role: 'tool',
			content: toolResultText(result),
			tool_call_id: result.tool_use_id,
		});
	}
	if (text || toolResults.length === 0) messages.push({ role: 'user', content: text });
}

function toOpenAIToolChoice(
	toolChoice: AnthropicRequest['tool_choice'] | undefined
): OpenAIChatRequest['tool_choice'] | undefined {
	if (!toolChoice) return undefined;
	switch (toolChoice.type) {
		case 'auto':
			return 'auto';
		case 'none':
			return 'none';
		case 'any':
			return 'auto';
		case 'tool':
			return { type: 'function', function: { name: toolChoice.name } };
	}
}

function buildOpenAIRequest(body: AnthropicRequest): OpenAIChatRequest {
	const messages: OpenAIChatMessage[] = [];
	const system = extractSystemText(body.system);
	if (system) messages.push({ role: 'system', content: system });
	for (const message of body.messages) appendOpenAIMessages(messages, message);

	const request: OpenAIChatRequest = {
		model: body.model,
		messages,
		stream: true,
	};
	if (body.max_tokens && body.max_tokens > 0) request.max_tokens = body.max_tokens;
	const toolChoice = toOpenAIToolChoice(body.tool_choice);
	if (toolChoice) request.tool_choice = toolChoice;
	if (body.tools && body.tools.length > 0) {
		request.tools = body.tools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.input_schema,
			},
		}));
	}
	return request;
}

function parseSseDataLine(line: string): OpenAIChatChunk | 'done' | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return null;
	const data = trimmed.slice(5).trim();
	if (!data) return null;
	if (data === '[DONE]') return 'done';
	try {
		return JSON.parse(data) as OpenAIChatChunk;
	} catch {
		logger.warn(`kimi bridge: ignoring malformed stream data: ${data.slice(0, 120)}`);
		return null;
	}
}

function applyOpenAIChunk(
	chunk: OpenAIChatChunk,
	state: {
		outputText: string;
		startedText: boolean;
		finishReason: string | null | undefined;
		finalPromptTokens: number | undefined;
		finalOutputTokens: number | undefined;
		toolCalls: Map<number, AccumulatedToolCall>;
	},
	send: (chunk: string) => void,
	blockIndex: number
): void {
	if (chunk.error) throw new Error(chunk.error.message || 'Kimi stream error');
	state.finalPromptTokens = chunk.usage?.prompt_tokens ?? state.finalPromptTokens;
	state.finalOutputTokens = chunk.usage?.completion_tokens ?? state.finalOutputTokens;
	for (const choice of chunk.choices ?? []) {
		state.finishReason = choice.finish_reason ?? state.finishReason;
		const text = choice.delta?.content ?? '';
		if (text) {
			if (!state.startedText) {
				send(contentBlockStartTextSSE(blockIndex));
				state.startedText = true;
			}
			state.outputText += text;
			send(textDeltaSSE(blockIndex, text));
		}
		for (const deltaToolCall of choice.delta?.tool_calls ?? []) {
			const index = deltaToolCall.index ?? 0;
			const accumulated = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
			if (deltaToolCall.id) accumulated.id = deltaToolCall.id;
			if (deltaToolCall.function?.name) accumulated.name += deltaToolCall.function.name;
			if (deltaToolCall.function?.arguments) {
				accumulated.arguments += deltaToolCall.function.arguments;
			}
			state.toolCalls.set(index, accumulated);
		}
	}
}

function emitToolCall(params: {
	send: (chunk: string) => void;
	toolCall: AccumulatedToolCall;
	index: number;
}): void {
	const toolUseId = params.toolCall.id || `toolu_kimi_${Math.random().toString(36).slice(2, 12)}`;
	params.send(contentBlockStartToolUseSSE(params.index, toolUseId, params.toolCall.name));
	params.send(inputJsonDeltaSSE(params.index, params.toolCall.arguments || '{}'));
	params.send(contentBlockStopSSE(params.index));
}

async function streamOpenAIToAnthropic(params: {
	openAIResponse: Response;
	controller: ReadableStreamDefaultController<Uint8Array>;
	model: string;
	inputTokens: number;
}): Promise<void> {
	const { openAIResponse, controller, model, inputTokens } = params;
	const encoder = new TextEncoder();
	const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
	let nextBlockIndex = 0;
	const state = {
		outputText: '',
		startedText: false,
		finishReason: undefined as string | null | undefined,
		finalPromptTokens: undefined as number | undefined,
		finalOutputTokens: undefined as number | undefined,
		toolCalls: new Map<number, AccumulatedToolCall>(),
	};

	try {
		send(
			messageStartSSE(`msg_kimi_${Math.random().toString(36).slice(2, 12)}`, model, inputTokens)
		);
		const reader = openAIResponse.body?.getReader();
		if (!reader) throw new Error('Kimi response did not include a stream body');
		const decoder = new TextDecoder();
		let buffer = '';
		let done = false;

		while (!done) {
			const read = await reader.read();
			if (read.done) break;
			buffer += decoder.decode(read.value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const chunk = parseSseDataLine(line);
				if (!chunk) continue;
				if (chunk === 'done') {
					done = true;
					break;
				}
				applyOpenAIChunk(chunk, state, send, nextBlockIndex);
			}
		}
		const tail = parseSseDataLine(buffer);
		if (tail && tail !== 'done') {
			applyOpenAIChunk(tail, state, send, nextBlockIndex);
		}

		if (state.startedText) {
			send(contentBlockStopSSE(nextBlockIndex));
			nextBlockIndex += 1;
		}
		const completedToolCalls = Array.from(state.toolCalls.values()).filter(
			(toolCall) => toolCall.name
		);
		for (const toolCall of completedToolCalls) {
			emitToolCall({ send, toolCall, index: nextBlockIndex });
			nextBlockIndex += 1;
		}
		if (!state.startedText && completedToolCalls.length === 0) {
			send(contentBlockStartTextSSE(nextBlockIndex));
			send(contentBlockStopSSE(nextBlockIndex));
		}
		const stopReason =
			completedToolCalls.length > 0
				? 'tool_use'
				: state.finishReason === 'length'
					? 'max_tokens'
					: 'end_turn';
		send(
			messageDeltaSSE(stopReason, {
				inputTokens: state.finalPromptTokens ?? inputTokens,
				outputTokens: state.finalOutputTokens ?? estimateTokens(state.outputText),
			})
		);
		send(messageStopSSE());
	} catch (error) {
		send(errorSSE('api_error', error instanceof Error ? error.message : 'Kimi stream failed'));
	} finally {
		controller.close();
	}
}

export function createKimiAnthropicBridgeServer(config: KimiBridgeConfig): KimiBridgeServer {
	const fetchImpl = config.fetchImpl ?? fetch;
	const baseUrl = config.baseUrl.replace(/\/$/, '');
	const authToken = config.authToken;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		idleTimeout: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname === '/health' || url.pathname === '/v1/health') return new Response('ok');
			const authHeader = req.headers.get('Authorization') ?? '';
			const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
			const reqToken = req.headers.get('x-api-key') || bearerToken;
			if (reqToken !== authToken) {
				return sendJsonError(401, 'authentication_error', 'Invalid or missing auth token');
			}
			if (url.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(
					JSON.stringify({ data: [{ id: 'default', type: 'model', display_name: 'Kimi' }] }),
					{
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
			if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
				try {
					const body = (await req.json()) as AnthropicRequest;
					return new Response(
						JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }),
						{
							headers: { 'Content-Type': 'application/json' },
						}
					);
				} catch {
					return sendJsonError(400, 'invalid_request_error', 'Bad Request');
				}
			}
			if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
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

			const requestBody = buildOpenAIRequest(body);
			const inputTokens = estimateTokens(
				requestBody.messages
					.map((message) => message.content ?? '')
					.filter(Boolean)
					.join('\n')
			);
			let openAIResponse: Response;
			try {
				openAIResponse = await fetchImpl(`${baseUrl}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${config.apiKey}`,
					},
					body: JSON.stringify(requestBody),
				});
			} catch (error) {
				return sendJsonError(
					502,
					'api_error',
					error instanceof Error ? error.message : 'Kimi API request failed'
				);
			}
			if (!openAIResponse.ok) {
				const text = await openAIResponse.text();
				return sendJsonError(
					openAIResponse.status,
					mapStatusToAnthropicError(openAIResponse.status),
					text || `Kimi API returned HTTP ${openAIResponse.status}`
				);
			}

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					void streamOpenAIToAnthropic({
						openAIResponse,
						controller,
						model: body.model,
						inputTokens,
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
	if (typeof port !== 'number') throw new Error('Kimi bridge server did not bind to a TCP port');
	logger.info(`kimi bridge: HTTP server listening on port ${port}`);
	return {
		port,
		stop: () => server.stop(true),
	};
}
