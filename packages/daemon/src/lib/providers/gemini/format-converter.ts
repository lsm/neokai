/**
 * Format Converter — Anthropic Messages API ↔ Gemini Code Assist API
 *
 * Translates between the Anthropic Messages API format (used by the Claude Agent SDK)
 * and the Gemini Code Assist `streamGenerateContent` format.
 *
 * Adapted from the Gemini CLI's converter.ts (Apache 2.0).
 *
 * Key conversions:
 * - Anthropic `messages[]` → Gemini `contents[]` (role + parts)
 * - Anthropic `system` → Gemini `systemInstruction`
 * - Anthropic `tools[]` → Gemini `tools[]` (function declarations)
 * - Anthropic `tool_choice` → Gemini `toolConfig`
 * - Anthropic `max_tokens` → Gemini `generationConfig.maxOutputTokens`
 */

import type {
	AnthropicMessage,
	AnthropicRequest,
	AnthropicTool,
	ToolChoice,
} from '../codex-anthropic-bridge/translator.js';

// ---------------------------------------------------------------------------
// Gemini Code Assist types
// ---------------------------------------------------------------------------

/** A single content part in the Gemini format. */
export interface GeminiPart {
	text?: string;
	functionCall?: {
		name: string;
		args: Record<string, unknown>;
	};
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
	};
}

/** A single content message in the Gemini format. */
export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

/** A Gemini function declaration (tool schema). */
export interface GeminiFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

/** A Gemini tool definition. */
export interface GeminiTool {
	functionDeclarations?: GeminiFunctionDeclaration[];
}

/** Gemini tool config (controls tool use behavior). */
export interface GeminiToolConfig {
	functionCallingConfig?: {
		mode?: 'AUTO' | 'ANY' | 'NONE';
		allowedFunctionNames?: string[];
	};
}

/** Gemini generation config. */
export interface GeminiGenerationConfig {
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
}

/** Gemini Code Assist request body. */
export interface GeminiRequest {
	model: string;
	project?: string;
	request: {
		contents: GeminiContent[];
		systemInstruction?: { parts: GeminiPart[] };
		tools?: GeminiTool[];
		toolConfig?: GeminiToolConfig;
		generationConfig?: GeminiGenerationConfig;
	};
}

/** A Gemini candidate (response part). */
export interface GeminiCandidate {
	content?: GeminiContent;
	finishReason?: string;
}

/** Gemini usage metadata. */
export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

/** Gemini Code Assist streaming response chunk. */
export interface GeminiResponseChunk {
	response?: {
		candidates?: GeminiCandidate[];
		usageMetadata?: GeminiUsageMetadata;
		modelVersion?: string;
	};
	traceId?: string;
}

// ---------------------------------------------------------------------------
// Anthropic → Gemini conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic Messages API request to a Gemini Code Assist request.
 */
export function anthropicToGemini(
	request: AnthropicRequest,
	options?: { project?: string; sessionId?: string }
): GeminiRequest {
	const contents = convertMessages(request.messages);
	const systemInstruction = convertSystem(request.system);
	const tools = convertTools(request.tools);
	const toolConfig = convertToolChoice(request.tool_choice);
	const generationConfig = convertGenerationConfig(request);

	return {
		model: convertModelId(request.model),
		project: options?.project,
		request: {
			contents,
			...(systemInstruction ? { systemInstruction } : {}),
			...(tools.length > 0 ? { tools } : {}),
			...(toolConfig ? { toolConfig } : {}),
			...(generationConfig ? { generationConfig } : {}),
		},
	};
}

/**
 * Map Anthropic model IDs to Gemini model IDs.
 */
export function convertModelId(modelId: string): string {
	// Pass through Gemini-style model IDs as-is
	if (modelId.startsWith('gemini-')) {
		return modelId;
	}

	// Map common Anthropic model names to Gemini equivalents
	const modelMap: Record<string, string> = {
		default: 'gemini-2.5-pro',
		sonnet: 'gemini-2.5-pro',
		opus: 'gemini-2.5-pro',
		haiku: 'gemini-2.5-flash',
	};

	return modelMap[modelId] ?? 'gemini-2.5-pro';
}

/**
 * Convert Anthropic messages to Gemini contents.
 */
export function convertMessages(messages: AnthropicMessage[]): GeminiContent[] {
	const contents: GeminiContent[] = [];

	// Build a map of tool_use_id → function name from prior tool_use blocks
	// so tool_result blocks can reference the correct function name.
	const toolNameMap = new Map<string, string>();

	// First pass: collect tool names from all tool_use blocks
	for (const msg of messages) {
		if (typeof msg.content === 'string') continue;
		for (const block of msg.content) {
			if (block.type === 'tool_use') {
				toolNameMap.set(block.id, block.name);
			}
		}
	}

	for (const msg of messages) {
		const role = msg.role === 'assistant' ? 'model' : 'user';

		if (typeof msg.content === 'string') {
			contents.push({
				role,
				parts: [{ text: msg.content }],
			});
			continue;
		}

		// Split content blocks into separate Gemini parts
		const parts: GeminiPart[] = [];
		const toolResultParts: GeminiPart[] = [];

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
				// Tool results need to be in a user-turn in Gemini format
				// with a functionResponse part using the original function name
				const textContent =
					typeof block.content === 'string'
						? block.content
						: block.content.map((c) => c.text).join('');

				// Look up the actual function name from the corresponding tool_use block
				const functionName =
					toolNameMap.get(block.tool_use_id) ?? extractToolNameFromId(block.tool_use_id);

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

		// Tool results must be in a user-turn
		if (toolResultParts.length > 0) {
			contents.push({ role: 'user', parts: toolResultParts });
		}
	}

	return contents;
}

/**
 * Convert Anthropic system prompt to Gemini systemInstruction.
 */
export function convertSystem(
	system: AnthropicRequest['system']
): { parts: GeminiPart[] } | undefined {
	if (!system) return undefined;

	const text = typeof system === 'string' ? system : system.map((b) => b.text).join('\n');

	if (!text) return undefined;

	return { parts: [{ text }] };
}

/**
 * Convert Anthropic tools to Gemini function declarations.
 */
export function convertTools(tools: AnthropicTool[] | undefined): GeminiTool[] {
	if (!tools || tools.length === 0) return [];

	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? '',
				parameters: convertSchema(tool.input_schema),
			})),
		},
	];
}

/**
 * Convert JSON Schema from Anthropic format to Gemini format.
 *
 * Gemini expects JSON Schema but with some differences:
 * - No `additionalProperties` field
 * - `anyOf` instead of `oneOf`
 */
export function convertSchema(schema: Record<string, unknown>): Record<string, unknown> {
	if (!schema) return schema;

	const result = { ...schema };

	// Remove additionalProperties (not supported by Gemini)
	delete result.additionalProperties;

	// Convert oneOf to anyOf
	if (result.oneOf) {
		result.anyOf = result.oneOf;
		delete result.oneOf;
	}

	// Recursively convert nested schemas
	if (result.properties && typeof result.properties === 'object') {
		const props = result.properties as Record<string, Record<string, unknown>>;
		result.properties = Object.fromEntries(
			Object.entries(props).map(([key, value]) => [key, convertSchema(value)])
		);
	}

	if (result.items && typeof result.items === 'object') {
		result.items = convertSchema(result.items as Record<string, unknown>);
	}

	if (result.anyOf && Array.isArray(result.anyOf)) {
		result.anyOf = result.anyOf.map((s: Record<string, unknown>) => convertSchema(s));
	}

	return result;
}

/**
 * Convert Anthropic tool_choice to Gemini toolConfig.
 */
export function convertToolChoice(
	toolChoice: ToolChoice | undefined
): GeminiToolConfig | undefined {
	if (!toolChoice) return undefined;

	switch (toolChoice.type) {
		case 'auto':
			return { functionCallingConfig: { mode: 'AUTO' } };
		case 'none':
			return { functionCallingConfig: { mode: 'NONE' } };
		case 'any':
			return { functionCallingConfig: { mode: 'ANY' } };
		case 'tool':
			return {
				functionCallingConfig: {
					mode: 'ANY',
					allowedFunctionNames: [toolChoice.name],
				},
			};
		default:
			return undefined;
	}
}

/**
 * Convert Anthropic generation parameters to Gemini generationConfig.
 */
export function convertGenerationConfig(
	request: AnthropicRequest
): GeminiGenerationConfig | undefined {
	const config: GeminiGenerationConfig = {};

	if (request.max_tokens) {
		config.maxOutputTokens = request.max_tokens;
	}

	if (config.maxOutputTokens === undefined) {
		return undefined;
	}

	return config;
}

// ---------------------------------------------------------------------------
// Gemini → Anthropic conversion (for streaming responses)
// ---------------------------------------------------------------------------

/** Track state for converting Gemini streaming chunks to Anthropic SSE events. */
export interface GeminiStreamState {
	messageId: string;
	model: string;
	contentBlockIndex: number;
	currentToolUseId: string | null;
	currentToolName: string | null;
	toolUseJsonBuffer: string;
	inputTokens: number;
	outputTokens: number;
	finished: boolean;
}

/** Create a new stream state tracker. */
export function createStreamState(model: string): GeminiStreamState {
	return {
		messageId: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
		model,
		contentBlockIndex: 0,
		currentToolUseId: null,
		currentToolName: null,
		toolUseJsonBuffer: '',
		inputTokens: 0,
		outputTokens: 0,
		finished: false,
	};
}

/**
 * Extract finish reason from a Gemini candidate.
 */
export function convertFinishReason(
	reason: string | undefined
): 'end_turn' | 'tool_use' | 'max_tokens' {
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

/**
 * Extract the tool name from a tool_use_id.
 * Falls back to 'unknown_tool' if parsing fails.
 */
function extractToolNameFromId(toolUseId: string): string {
	// In practice, tool_use_ids are random. We need the actual tool name
	// from the corresponding tool_use block. This is a fallback.
	return `tool_${toolUseId.slice(0, 8)}`;
}

/**
 * Get text parts from a Gemini candidate.
 */
export function extractTextFromCandidate(candidate: GeminiCandidate): string {
	if (!candidate?.content?.parts) return '';
	return candidate.content.parts
		.filter((p) => p.text !== undefined)
		.map((p) => p.text!)
		.join('');
}

/**
 * Get function call parts from a Gemini candidate.
 */
export function extractFunctionCallsFromCandidate(
	candidate: GeminiCandidate
): Array<{ name: string; args: Record<string, unknown> }> {
	if (!candidate?.content?.parts) return [];
	return candidate.content.parts
		.filter((p) => p.functionCall !== undefined)
		.map((p) => p.functionCall!);
}
