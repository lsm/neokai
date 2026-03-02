/**
 * Pi-Mono Adapter
 *
 * Provides integration with the @mariozechner/pi-ai SDK for providers that don't use
 * the Claude Agent SDK (e.g., OpenAI, GitHub Copilot).
 *
 * This adapter:
 * - Translates NeoKai message formats to/from pi-agent-core format
 * - Uses the pi-agent-core Agent class for automatic multi-turn tool calling
 * - Handles tool execution via callback to NeoKai's tool handlers
 * - Emits events that map to NeoKai SDK message format
 */

import type { UUID } from 'crypto';
import type {
	SDKMessage,
	SDKUserMessage,
	SDKAssistantMessage,
	SDKSystemMessage,
	SDKToolProgressMessage,
	SDKResultMessage,
} from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
	ToolDefinition,
} from '@neokai/shared/provider/query-types';
import { generateUUID } from '@neokai/shared';
import { Agent, type AgentTool, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { getModel, Type } from '@mariozechner/pi-ai';
import type {
	Api,
	Model,
	TSchema,
	TextContent,
	ImageContent,
	ToolResultMessage as PiToolResultMessage,
} from '@mariozechner/pi-ai';
import { Logger } from '../logger.js';

const logger = new Logger('pimono-adapter');

/**
 * Tool execution callback type
 * Called when pi-agent-core needs to execute a tool
 */
export type ToolExecutionCallback = (
	toolName: string,
	toolInput: Record<string, unknown>,
	toolUseId: string
) => Promise<{ output: unknown; isError: boolean }>;

/**
 * Map NeoKai provider names to pi-ai provider names
 */
function mapProviderToPiAi(provider: string): string {
	// NeoKai uses 'openai' and 'github-copilot' which match pi-ai directly
	return provider;
}

/**
 * Convert SDK user message content to pi-ai AgentMessage format
 */
export function sdkToAgentMessage(message: SDKUserMessage): AgentMessage {
	const content = message.message.content;
	const timestamp = Date.now();

	// Handle string content
	if (typeof content === 'string') {
		return {
			role: 'user',
			content,
			timestamp,
		};
	}

	// Handle array content
	if (Array.isArray(content)) {
		const textParts: TextContent[] = [];
		const imageParts: ImageContent[] = [];

		for (const block of content) {
			if (block.type === 'text') {
				textParts.push({ type: 'text', text: block.text });
			} else if (block.type === 'image') {
				if ('source' in block && block.source.type === 'base64') {
					imageParts.push({
						type: 'image',
						data: block.source.data,
						mimeType: block.source.media_type,
					});
				}
			} else if (block.type === 'tool_result') {
				// Tool results are handled separately by pi-agent-core
				// We should not see them in user messages, but if we do,
				// convert to a tool result message
				const resultText =
					typeof block.content === 'string' ? block.content : JSON.stringify(block.content);

				const toolResult: PiToolResultMessage = {
					role: 'toolResult',
					toolCallId: block.tool_use_id,
					toolName: 'unknown',
					content: [{ type: 'text', text: resultText }],
					isError: block.is_error ?? false,
					timestamp,
				};
				return toolResult;
			}
		}

		// Combine text and image parts
		const combinedContent: Array<TextContent | ImageContent> = [...textParts, ...imageParts];

		// Return user message with combined content
		if (combinedContent.length === 0) {
			return {
				role: 'user',
				content: '',
				timestamp,
			};
		}

		// If only text, return as string for cleaner format
		if (textParts.length === 1 && imageParts.length === 0) {
			return {
				role: 'user',
				content: textParts[0].text,
				timestamp,
			};
		}

		return {
			role: 'user',
			content: combinedContent,
			timestamp,
		};
	}

	// Fallback
	return {
		role: 'user',
		content: JSON.stringify(content),
		timestamp,
	};
}

/**
 * Convert NeoKai tool definitions to pi-agent-core AgentTool format
 */
export function convertToAgentTools(
	tools: ToolDefinition[],
	toolExecutor?: ToolExecutionCallback,
	_signal?: AbortSignal
): AgentTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		label: tool.name, // Use name as label
		// Use a generic record type schema that accepts any object
		parameters: Type.Record(Type.String(), Type.Any()) as unknown as TSchema,
		// The execute method is called by pi-agent-core when the LLM wants to use this tool
		execute: async (toolCallId: string, params: unknown) => {
			logger.debug(`Tool ${tool.name} called with ID ${toolCallId}`);
			const typedParams = params as Record<string, unknown>;

			if (!toolExecutor) {
				logger.warn(`No tool executor provided for tool ${tool.name}`);
				return {
					content: [{ type: 'text' as const, text: 'Error: No tool executor available' }],
					details: { error: 'No tool executor available' },
				};
			}

			try {
				const result = await toolExecutor(tool.name, typedParams, toolCallId);

				// Convert result to AgentToolResult format
				const resultText =
					typeof result.output === 'string'
						? result.output
						: JSON.stringify(result.output);

				return {
					content: [
						{
							type: 'text' as const,
							text: result.isError ? `[Tool Error] ${resultText}` : resultText,
						},
					],
					details: result,
				};
			} catch (error) {
				logger.error(`Tool ${tool.name} execution failed:`, error);
				return {
					content: [
						{
							type: 'text' as const,
							text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	}));
}

/**
 * Convert pi-ai AssistantMessage content to SDK assistant message format
 */
export function piAiToSdkAssistant(
	content: Array<TextContent | { type: 'thinking'; thinking: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }>,
	sessionId: string,
	parentToolUseId: string | null = null,
	error?: SDKAssistantMessage['error']
): SDKAssistantMessage {
	const messageContent = content.map((block) => {
		if (block.type === 'text') {
			return { type: 'text' as const, text: block.text };
		}
		if (block.type === 'toolCall') {
			return {
				type: 'tool_use' as const,
				id: block.id,
				name: block.name,
				input: block.arguments,
			};
		}
		if (block.type === 'thinking') {
			// Convert thinking blocks to text with markers
			return { type: 'text' as const, text: `<thinking>${block.thinking}</thinking>` };
		}
		return { type: 'text' as const, text: JSON.stringify(block) };
	});

	return {
		type: 'assistant',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: parentToolUseId,
		...(error ? { error } : {}),
		message: {
			role: 'assistant',
			content: messageContent,
		},
	};
}

/**
 * Create a system init message (required by NeoKai at start of session)
 */
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
		claude_code_version: 'pi-agent-core-adapter',
	};
}

/**
 * Create a tool progress message
 */
function createToolProgressMessage(
	sessionId: string,
	toolName: string,
	toolUseId: string,
	parentToolUseId: string | null,
	elapsedSeconds: number
): SDKToolProgressMessage {
	return {
		type: 'tool_progress',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		tool_name: toolName,
		tool_use_id: toolUseId,
		parent_tool_use_id: parentToolUseId,
		elapsed_time_seconds: elapsedSeconds,
	};
}

/**
 * Create a stream event message for text deltas
 */
function createStreamEvent(
	sessionId: string,
	textDelta: string,
	parentToolUseId: string | null = null
): SDKMessage {
	return {
		type: 'stream_event',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: parentToolUseId,
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: {
				type: 'text_delta',
				text: textDelta,
			},
		} as unknown as SDKMessage extends { type: 'stream_event' } ? SDKMessage['event'] : never,
	};
}

/**
 * Extended usage tracking with full cost information
 */
interface ExtendedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * Model context info for result messages
 */
interface ModelContextInfo {
	contextWindow: number;
	maxTokens: number;
}

/**
 * Create a result message (success or error)
 */
function createResultMessage(
	sessionId: string,
	success: boolean,
	durationMs: number,
	numTurns: number,
	resultText: string = '',
	errorMessage?: string,
	usage?: ExtendedUsage,
	modelContextInfo?: ModelContextInfo
): SDKResultMessage {
	const totalCostUsd = usage?.cost.total ?? 0;

	const base = {
		type: 'result' as const,
		duration_ms: durationMs,
		duration_api_ms: durationMs,
		num_turns: numTurns,
		total_cost_usd: totalCostUsd,
		usage: {
			input_tokens: usage?.input ?? 0,
			output_tokens: usage?.output ?? 0,
			cache_read_input_tokens: usage?.cacheRead ?? 0,
			cache_creation_input_tokens: usage?.cacheWrite ?? 0,
		},
		modelUsage: modelContextInfo
			? {
					[modelContextInfo.contextWindow + '']: {
						inputTokens: usage?.input ?? 0,
						outputTokens: usage?.output ?? 0,
						cacheReadInputTokens: usage?.cacheRead ?? 0,
						cacheCreationInputTokens: usage?.cacheWrite ?? 0,
						webSearchRequests: 0,
						costUSD: totalCostUsd,
						contextWindow: modelContextInfo.contextWindow,
						maxOutputTokens: modelContextInfo.maxTokens,
					},
				}
			: {},
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
		errors: [errorMessage || 'Unknown error'],
		stop_reason: errorMessage || 'Unknown error',
	} as SDKResultMessage;
}

/**
 * Main pi-agent-core query generator
 *
 * This function creates an AsyncGenerator that yields SDKMessages, compatible
 * with NeoKai's QueryRunner. It uses the Agent class from pi-agent-core for
 * automatic multi-turn tool calling.
 *
 * IMPORTANT: The prompt generator is designed for streaming input mode where
 * it yields ONE message at a time and then blocks. We must only consume ONE
 * message per call to avoid hanging indefinitely.
 *
 * @param prompt - AsyncGenerator of SDK user messages
 * @param options - Query options (model, tools, cwd, etc.)
 * @param context - Execution context (signal, sessionId)
 * @param provider - Provider identifier (e.g., 'openai', 'github-copilot')
 * @param modelId - Provider-specific model ID
 * @param toolExecutor - Optional callback for executing tools
 */
export async function* piMonoQueryGenerator(
	prompt: AsyncGenerator<SDKUserMessage>,
	options: ProviderQueryOptions,
	context: ProviderQueryContext,
	provider: string,
	modelId: string,
	toolExecutor?: ToolExecutionCallback
): AsyncGenerator<SDKMessage, void, unknown> {
	const startTime = Date.now();
	let turnCount = 0;
	const totalUsage: ExtendedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
	let modelContextInfo: ModelContextInfo | undefined;

	// Track tool execution times for progress messages
	const toolExecutionStartTimes = new Map<string, number>();

	// CRITICAL: Only consume ONE message from the prompt generator.
	// The prompt generator is designed for streaming input mode where it yields
	// one message and then blocks waiting for more. Using `for await` would
	// hang indefinitely because the generator never completes on its own.
	const firstMessage = await prompt.next();
	if (firstMessage.done) {
		logger.warn('Prompt generator yielded no messages');
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

	// Get the model using pi-ai SDK
	const piAiProvider = mapProviderToPiAi(provider);
	const model = getModel(
		piAiProvider as 'openai' | 'github-copilot',
		modelId as never
	) as Model<Api> | undefined;

	if (!model) {
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			`Unknown model: ${piAiProvider}/${modelId}`
		);
		return;
	}

	// Extract model context info for reporting
	if ('contextWindow' in model && 'maxTokens' in model) {
		modelContextInfo = {
			contextWindow: (model as unknown as { contextWindow: number }).contextWindow,
			maxTokens: (model as unknown as { maxTokens: number }).maxTokens,
		};
	}

	// Convert user message to AgentMessage format
	const agentMessages: AgentMessage[] = [sdkToAgentMessage(userMessage)];

	// Convert tools to AgentTool format
	const agentTools = options.tools.length > 0
		? convertToAgentTools(options.tools, toolExecutor, context.signal)
		: [];

	// Create Agent instance
	const agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt || '',
			model: model,
			tools: agentTools,
			messages: [],
			thinkingLevel: 'off', // Default thinking level
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set(),
		},
		sessionId: context.sessionId,
		getApiKey: async () => options.apiKey,
	});

	// Subscribe to agent events
	const eventQueue: AgentEvent[] = [];

	// Use mutable refs for closure capture
	const state = {
		resolveEventCallback: null as ((value: AgentEvent | null) => void) | null,
		agentDone: false,
		agentError: null as Error | null,
	};

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		eventQueue.push(event);

		// Track usage from turn_end events
		if (event.type === 'turn_end') {
			turnCount++;
			// Extract usage if available from the message
			// Note: AgentMessage may not have usage info directly, we'll get it from the final result
		}

		// Signal that a new event is available
		const cb = state.resolveEventCallback;
		if (cb) {
			state.resolveEventCallback = null;
			cb(eventQueue.shift() ?? null);
		}
	});

	// Helper to get next event from queue
	const getNextEvent = async (): Promise<AgentEvent | null> => {
		if (eventQueue.length > 0) {
			return eventQueue.shift()!;
		}
		if (state.agentDone) {
			return null;
		}
		// Wait for new event
		return new Promise((resolve) => {
			state.resolveEventCallback = resolve;
		});
	};

	// Start the agent in the background
	const agentPromise = (async () => {
		try {
			// Run the agent with the messages
			// The agent will automatically handle multi-turn tool calling
			await agent.prompt(agentMessages);
		} catch (error) {
			state.agentError = error instanceof Error ? error : new Error('Unknown agent error');
		} finally {
			state.agentDone = true;
			const cb = state.resolveEventCallback;
			if (cb) {
				state.resolveEventCallback = null;
				cb(null);
			}
		}
	})();

	// Yield system init message first
	yield createSystemInitMessage(context.sessionId, options);

	// Process events as they come in
	let accumulatedText = '';

	while (!state.agentDone || eventQueue.length > 0) {
		if (context.signal.aborted) {
			agent.abort();
			break;
		}

		const event = await getNextEvent();
		if (!event) {
			// Check if agent is truly done
			if (state.agentDone) break;
			continue;
		}

		switch (event.type) {
			case 'agent_start':
				logger.debug('Agent started');
				break;

			case 'turn_start':
				logger.debug('Turn started');
				break;

			case 'message_start':
				// New message being streamed
				logger.debug('Message started');
				accumulatedText = '';
				break;

			case 'message_update':
				// Streaming text delta
				if (event.assistantMessageEvent?.type === 'text_delta') {
					const delta = event.assistantMessageEvent.delta;
					if (delta) {
						accumulatedText += delta;
						yield createStreamEvent(context.sessionId, delta);
					}
				}
				break;

			case 'message_end':
				// Message completed
				logger.debug('Message ended');
				// Yield the complete assistant message
				if (event.message && 'role' in event.message && event.message.role === 'assistant') {
					// Extract content from assistant message
					const assistantMsg = event.message as {
						content: Array<TextContent | { type: 'thinking'; thinking: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }>;
						usage?: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							totalTokens: number;
							cost: {
								input: number;
								output: number;
								cacheRead: number;
								cacheWrite: number;
								total: number;
							};
						};
					};

					// Accumulate full usage info
					if (assistantMsg.usage) {
						totalUsage.input += assistantMsg.usage.input || 0;
						totalUsage.output += assistantMsg.usage.output || 0;
						totalUsage.cacheRead += assistantMsg.usage.cacheRead || 0;
						totalUsage.cacheWrite += assistantMsg.usage.cacheWrite || 0;
						totalUsage.totalTokens += assistantMsg.usage.totalTokens || 0;
						if (assistantMsg.usage.cost) {
							totalUsage.cost.input += assistantMsg.usage.cost.input || 0;
							totalUsage.cost.output += assistantMsg.usage.cost.output || 0;
							totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead || 0;
							totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite || 0;
							totalUsage.cost.total += assistantMsg.usage.cost.total || 0;
						}
					}

					yield piAiToSdkAssistant(assistantMsg.content, context.sessionId);
				}
				break;

			case 'tool_execution_start':
				// Tool execution started
				toolExecutionStartTimes.set(event.toolCallId, Date.now());
				yield createToolProgressMessage(
					context.sessionId,
					event.toolName,
					event.toolCallId,
					null,
					0
				);
				break;

			case 'tool_execution_update':
				// Tool execution progress update (optional)
				logger.debug(`Tool ${event.toolName} progress:`, event.partialResult);
				break;

			case 'tool_execution_end':
				// Tool execution completed
				{
					const startedAt = toolExecutionStartTimes.get(event.toolCallId);
					const elapsedSeconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
					toolExecutionStartTimes.delete(event.toolCallId);

					yield createToolProgressMessage(
						context.sessionId,
						event.toolName,
						event.toolCallId,
						null,
						elapsedSeconds
					);

					logger.debug(`Tool ${event.toolName} completed, isError: ${event.isError}`);
				}
				break;

			case 'turn_end':
				// Turn completed - tool results are included in the event
				logger.debug('Turn ended');
				break;

			case 'agent_end':
				// Agent finished completely
				logger.debug('Agent ended');
				break;
		}
	}

	// Wait for agent to fully complete
	try {
		await agentPromise;
	} catch (error) {
		logger.error('Agent promise error:', error);
	}

	// Cleanup subscription
	unsubscribe();

	// Handle errors
	if (state.agentError) {
		yield createResultMessage(
			context.sessionId,
			false,
			Date.now() - startTime,
			turnCount,
			'',
			state.agentError.message
		);
		return;
	}

	// Handle abort
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

	// Yield success result
	yield createResultMessage(
		context.sessionId,
		true,
		Date.now() - startTime,
		turnCount,
		accumulatedText || 'Task completed successfully.',
		undefined,
		totalUsage,
		modelContextInfo
	);
}
