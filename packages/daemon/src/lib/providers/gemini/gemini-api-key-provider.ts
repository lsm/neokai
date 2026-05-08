/**
 * Google Gemini API Key Provider
 *
 * Provides Anthropic-compatible bridge for Google Gemini models using the
 * standard Gemini API (`generativelanguage.googleapis.com`) with an API key.
 *
 * Uses the `@google/genai` SDK directly — no OAuth, no Code Assist API,
 * no bridge server talking to internal endpoints.
 *
 * Authentication: GOOGLE_API_KEY or GEMINI_API_KEY environment variable.
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { createLogger } from '@neokai/shared/logger';
import {
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	contentBlockStopSSE,
	inputJsonDeltaSSE,
	messageDeltaSSE,
	messageStartSSE,
	messageStopSSE,
	textDeltaSSE,
	type AnthropicRequest,
} from '../provider-anthropic-compat/translator.js';
import { createAnthropicErrorBody } from '../shared/error-envelope.js';

const log = createLogger('kai:providers:gemini:apikey');

// ---------------------------------------------------------------------------
// Static model list (Gemini API — no dynamic discovery needed)
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelInfo[] = [
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		alias: 'gemini-2.5-pro',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Pro',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		alias: 'gemini-2.5-flash',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Flash',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-2.5-flash-lite',
		name: 'Gemini 2.5 Flash Lite',
		alias: 'gemini-2.5-flash-lite',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Flash Lite',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-2.0-flash',
		name: 'Gemini 2.0 Flash',
		alias: 'gemini-2.0-flash',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.0 Flash',
		releaseDate: '2025-02-01',
		available: true,
	},
	{
		id: 'gemini-2.0-flash-lite',
		name: 'Gemini 2.0 Flash Lite',
		alias: 'gemini-2.0-flash-lite',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.0 Flash Lite',
		releaseDate: '2025-02-01',
		available: true,
	},
	{
		id: 'gemini-2.0-pro',
		name: 'Gemini 2.0 Pro',
		alias: 'gemini-2.0-pro',
		family: 'gemini',
		provider: 'google-gemini',
		contextWindow: 2_000_000,
		description: 'Google Gemini 2.0 Pro (2M context)',
		releaseDate: '2025-02-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// Types — inline shapes matching @google/genai so we don't depend on
//         the non-exported `types` namespace at the type level.
// ---------------------------------------------------------------------------

interface GenAIPart {
	text?: string;
	functionCall?: { name?: string; args?: Record<string, unknown> };
	functionResponse?: { name?: string; response?: Record<string, unknown> };
}

interface GenAIContent {
	role?: string;
	parts?: GenAIPart[];
}

interface GenAITool {
	functionDeclarations?: Array<{
		name?: string;
		description?: string;
		parameters?: Record<string, unknown>;
	}>;
}

interface GenAIToolConfig {
	functionCallingConfig?: {
		mode?: 'AUTO' | 'ANY' | 'NONE' | 'MODE_UNSPECIFIED' | 'VALIDATED';
		allowedFunctionNames?: string[];
	};
}

interface GeminiApiKeyBridgeServer {
	port: number;
	stop(): void;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GeminiApiKeyProvider implements Provider {
	readonly id = 'google-gemini';
	readonly displayName = 'Google Gemini';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		thinkingModes: 'off',
		maxContextWindow: 2_000_000,
		functionCalling: true,
		vision: true,
	};

	private bridgeServers = new Map<string, GeminiApiKeyBridgeServer>();

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	/**
	 * Check if provider is available (has API key configured).
	 */
	isAvailable(): boolean {
		return !!this.getApiKey();
	}

	/**
	 * Get API key from environment.
	 * Supports GOOGLE_API_KEY and GEMINI_API_KEY.
	 */
	getApiKey(): string | undefined {
		return this.env.GOOGLE_API_KEY || this.env.GEMINI_API_KEY;
	}

	/**
	 * Get available models.
	 * Returns static list when API key is available.
	 */
	async getModels(): Promise<ModelInfo[]> {
		return this.isAvailable() ? [...GEMINI_MODELS] : [];
	}

	/**
	 * Check if a model ID belongs to this provider.
	 */
	ownsModel(modelId: string): boolean {
		return modelId.startsWith('gemini-') || modelId.startsWith('gemma-');
	}

	/**
	 * Get model for a specific tier.
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			sonnet: 'gemini-2.5-pro',
			haiku: 'gemini-2.5-flash',
			opus: 'gemini-2.5-pro',
			default: 'gemini-2.5-pro',
		};
		return tierMap[tier];
	}

	/**
	 * Build SDK configuration for this provider.
	 *
	 * Creates a local bridge server that accepts Anthropic Messages API requests
	 * and translates them to Gemini API calls via `@google/genai`.
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const sessionId = sessionConfig?.sessionId ?? 'default';
		const apiKey = sessionConfig?.apiKey || this.getApiKey();

		if (!apiKey) {
			throw new Error(
				'Google Gemini API key not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY.'
			);
		}

		let bridge = this.bridgeServers.get(sessionId);
		if (!bridge) {
			bridge = createGeminiApiKeyBridgeServer({ apiKey, sessionId });
			this.bridgeServers.set(sessionId, bridge);
			log.info(`API key bridge server started on port ${bridge.port} for session ${sessionId}`);
		}

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
				ANTHROPIC_API_KEY: 'gemini-apikey-placeholder',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Get authentication status.
	 */
	async getAuthStatus() {
		const apiKey = this.getApiKey();
		if (!apiKey) {
			return {
				isAuthenticated: false,
				method: 'api_key' as const,
				error: 'No Google Gemini API key configured. Set GOOGLE_API_KEY or GEMINI_API_KEY.',
			};
		}
		return {
			isAuthenticated: true,
			method: 'api_key' as const,
		};
	}

	/**
	 * Shut down all bridge servers.
	 */
	async shutdown(): Promise<void> {
		for (const [sessionId, bridge] of this.bridgeServers.entries()) {
			log.info(`Shutting down API key bridge server for session ${sessionId}`);
			bridge.stop();
		}
		this.bridgeServers.clear();
	}
}

// ---------------------------------------------------------------------------
// Bridge Server
// ---------------------------------------------------------------------------

interface GeminiApiKeyBridgeConfig {
	apiKey: string;
	sessionId?: string;
}

function createGeminiApiKeyBridgeServer(
	config: GeminiApiKeyBridgeConfig
): GeminiApiKeyBridgeServer {
	const { GoogleGenAI } = require('@google/genai') as typeof import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: config.apiKey });

	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			if (url.pathname === '/health' || url.pathname === '/v1/health') {
				return new Response('ok');
			}

			if (url.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(
					JSON.stringify({
						data: GEMINI_MODELS.map((m) => ({
							id: m.id,
							display_name: m.name,
							type: 'model',
						})),
					}),
					{ headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.pathname !== '/v1/messages' && url.pathname !== '/v1/messages/') {
				return new Response(createAnthropicErrorBody('not_found_error', 'Not found'), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (req.method !== 'POST') {
				return new Response(
					createAnthropicErrorBody('invalid_request_error', 'Method not allowed'),
					{ status: 405, headers: { 'Content-Type': 'application/json' } }
				);
			}

			let anthropicRequest: AnthropicRequest;
			try {
				anthropicRequest = (await req.json()) as AnthropicRequest;
			} catch {
				return new Response(createAnthropicErrorBody('invalid_request_error', 'Invalid JSON'), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const isStreaming = anthropicRequest.stream !== false;

			try {
				if (isStreaming) {
					return await streamViaGenAI(ai, anthropicRequest);
				}
				return await generateViaGenAI(ai, anthropicRequest);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`Gemini API key request failed: ${message}`);
				return new Response(
					createAnthropicErrorBody(
						message.includes('API key') ? 'authentication_error' : 'api_error',
						message
					),
					{ status: 500, headers: { 'Content-Type': 'application/json' } }
				);
			}
		},
	});

	return {
		port: server.port ?? 0,
		stop: () => server.stop(),
	};
}

// ---------------------------------------------------------------------------
// Anthropic → @google/genai conversion
// ---------------------------------------------------------------------------

function convertToGenAIContents(request: AnthropicRequest): GenAIContent[] {
	const contents: GenAIContent[] = [];
	const toolNameMap = new Map<string, string>();

	// First pass: collect tool names
	for (const msg of request.messages) {
		if (typeof msg.content === 'string') continue;
		for (const block of msg.content) {
			if (block.type === 'tool_use') {
				toolNameMap.set(block.id, block.name);
			}
		}
	}

	for (const msg of request.messages) {
		const role = msg.role === 'assistant' ? 'model' : 'user';

		if (typeof msg.content === 'string') {
			contents.push({ role, parts: [{ text: msg.content }] });
			continue;
		}

		const parts: GenAIPart[] = [];
		const toolResultParts: GenAIPart[] = [];

		for (const block of msg.content) {
			if (block.type === 'text') {
				parts.push({ text: block.text });
			} else if (block.type === 'tool_use') {
				parts.push({
					functionCall: {
						name: block.name,
						args: block.input as Record<string, unknown>,
					},
				});
			} else if (block.type === 'tool_result') {
				const textContent =
					typeof block.content === 'string'
						? block.content
						: block.content.map((c) => c.text).join('');

				const functionName = toolNameMap.get(block.tool_use_id) ?? 'unknown_tool';

				toolResultParts.push({
					functionResponse: {
						name: functionName,
						response: { result: textContent },
					},
				});
			}
		}

		if (parts.length > 0) {
			contents.push({ role, parts });
		}
		if (toolResultParts.length > 0) {
			contents.push({ role: 'user', parts: toolResultParts });
		}
	}

	return contents;
}

function convertSystemInstruction(system: AnthropicRequest['system']): GenAIContent | undefined {
	if (!system) return undefined;
	const text = typeof system === 'string' ? system : system.map((b) => b.text).join('\n');
	if (!text) return undefined;
	return { parts: [{ text }] };
}

function convertTools(tools: AnthropicRequest['tools']): GenAITool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? '',
				parameters: tool.input_schema as Record<string, unknown>,
			})),
		},
	];
}

function convertToolChoice(
	toolChoice: AnthropicRequest['tool_choice']
): GenAIToolConfig | undefined {
	if (!toolChoice) return undefined;

	const { FunctionCallingConfigMode } = require('@google/genai') as typeof import('@google/genai');

	switch (toolChoice.type) {
		case 'auto':
			return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
		case 'none':
			return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
		case 'any':
			return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
		case 'tool':
			return {
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.ANY,
					allowedFunctionNames: [toolChoice.name],
				},
			};
		default:
			return undefined;
	}
}

function convertModelId(modelId: string): string {
	if (modelId.startsWith('gemini-') || modelId.startsWith('gemma-')) {
		return modelId;
	}
	const map: Record<string, string> = {
		default: 'gemini-2.5-pro',
		sonnet: 'gemini-2.5-pro',
		opus: 'gemini-2.5-pro',
		haiku: 'gemini-2.5-flash',
	};
	return map[modelId] ?? 'gemini-2.5-pro';
}

// ---------------------------------------------------------------------------
// Streaming via @google/genai
// ---------------------------------------------------------------------------

async function streamViaGenAI(
	ai: import('@google/genai').GoogleGenAI,
	request: AnthropicRequest
): Promise<Response> {
	const model = convertModelId(request.model);
	const contents = convertToGenAIContents(request);
	const systemInstruction = convertSystemInstruction(request.system);
	const tools = convertTools(request.tools);
	const toolConfig = convertToolChoice(request.tool_choice);

	const config = {
		...(systemInstruction ? { systemInstruction } : {}),
		...(tools ? { tools } : {}),
		...(toolConfig ? { toolConfig } : {}),
		...(request.max_tokens ? { maxOutputTokens: request.max_tokens } : {}),
	};

	const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
	let inputTokens = 0;
	let outputTokens = 0;
	let contentBlockIndex = 0;
	let hasSeenFunctionCall = false;
	let finished = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(messageStartSSE(messageId, request.model, 0)));

			try {
				const response = await ai.models.generateContentStream({
					model,
					contents,
					config,
				} as unknown as Parameters<typeof ai.models.generateContentStream>[0]);

				for await (const chunk of response) {
					if (chunk.usageMetadata) {
						inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
						outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
					}

					const candidates = chunk.candidates ?? [];
					for (const candidate of candidates) {
						let chunkHasFunctionCall = false;

						if (candidate.content?.parts) {
							for (const part of candidate.content.parts) {
								if (part.text !== undefined) {
									controller.enqueue(encoder.encode(contentBlockStartTextSSE(contentBlockIndex)));
									controller.enqueue(encoder.encode(textDeltaSSE(contentBlockIndex, part.text)));
									controller.enqueue(encoder.encode(contentBlockStopSSE(contentBlockIndex)));
									contentBlockIndex++;
									outputTokens += Math.ceil(part.text.length / 4);
								} else if (part.functionCall) {
									chunkHasFunctionCall = true;
									hasSeenFunctionCall = true;
									const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
									const argsJson = JSON.stringify(part.functionCall.args ?? {});

									controller.enqueue(
										encoder.encode(
											contentBlockStartToolUseSSE(
												contentBlockIndex,
												toolUseId,
												part.functionCall.name ?? 'unknown_tool'
											)
										)
									);
									controller.enqueue(
										encoder.encode(inputJsonDeltaSSE(contentBlockIndex, argsJson))
									);
									controller.enqueue(encoder.encode(contentBlockStopSSE(contentBlockIndex)));
									contentBlockIndex++;
								}
							}
						}

						if (candidate.finishReason) {
							const stopReason =
								chunkHasFunctionCall || hasSeenFunctionCall
									? 'tool_use'
									: convertFinishReason(candidate.finishReason);
							controller.enqueue(
								encoder.encode(
									messageDeltaSSE(stopReason, {
										outputTokens: Math.max(outputTokens, 1),
									})
								)
							);
							controller.enqueue(encoder.encode(messageStopSSE()));
							finished = true;
						}
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`Streaming error: ${message}`);
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({
							type: 'error',
							error: { type: 'api_error', message },
						})}\n\n`
					)
				);
			}

			if (!finished) {
				controller.enqueue(
					encoder.encode(
						messageDeltaSSE('end_turn', {
							outputTokens: Math.max(outputTokens, 1),
						})
					)
				);
				controller.enqueue(encoder.encode(messageStopSSE()));
			}

			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

// ---------------------------------------------------------------------------
// Non-streaming via @google/genai
// ---------------------------------------------------------------------------

async function generateViaGenAI(
	ai: import('@google/genai').GoogleGenAI,
	request: AnthropicRequest
): Promise<Response> {
	const model = convertModelId(request.model);
	const contents = convertToGenAIContents(request);
	const systemInstruction = convertSystemInstruction(request.system);
	const tools = convertTools(request.tools);
	const toolConfig = convertToolChoice(request.tool_choice);

	const config = {
		...(systemInstruction ? { systemInstruction } : {}),
		...(tools ? { tools } : {}),
		...(toolConfig ? { toolConfig } : {}),
		...(request.max_tokens ? { maxOutputTokens: request.max_tokens } : {}),
	};

	const response = await ai.models.generateContent({
		model,
		contents,
		config,
	} as unknown as Parameters<typeof ai.models.generateContent>[0]);

	const contentBlocks: Array<Record<string, unknown>> = [];
	let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
	let inputTokens = 0;
	let outputTokens = 0;
	let hasFunctionCall = false;

	if (response.usageMetadata) {
		inputTokens = response.usageMetadata.promptTokenCount ?? 0;
		outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
	}

	for (const candidate of response.candidates ?? []) {
		if (candidate.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					contentBlocks.push({ type: 'text', text: part.text });
				} else if (part.functionCall) {
					hasFunctionCall = true;
					contentBlocks.push({
						type: 'tool_use',
						id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
						name: part.functionCall.name ?? 'unknown_tool',
						input: part.functionCall.args ?? {},
					});
				}
			}
		}
		if (candidate.finishReason) {
			stopReason = hasFunctionCall ? 'tool_use' : convertFinishReason(candidate.finishReason);
		}
	}

	return new Response(
		JSON.stringify({
			id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
			type: 'message',
			role: 'assistant',
			content: contentBlocks,
			model: request.model,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			},
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function convertFinishReason(reason: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' {
	switch (reason) {
		case 'STOP':
			return 'end_turn';
		case 'SAFETY':
		case 'MAX_TOKENS':
			return 'max_tokens';
		case 'RECITATION':
			return 'end_turn';
		default:
			return 'end_turn';
	}
}
