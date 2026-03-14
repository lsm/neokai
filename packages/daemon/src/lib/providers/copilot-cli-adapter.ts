/**
 * GitHub Copilot CLI Adapter
 *
 * Transparent backend for AgentSession using the GitHub Copilot CLI binary
 * (`copilot`) instead of the pi-agent-core API adapter.
 *
 * ## Architecture
 *
 * This adapter takes a fundamentally different approach from the pi-mono adapter:
 * - **Pi-Mono**: Provides tool definitions + executes tool callbacks when called
 * - **Copilot CLI**: The CLI handles ALL tool execution autonomously
 *
 * The Copilot CLI is an autonomous agent that reads/writes files, runs shell
 * commands, and calls GitHub APIs based on the prompt. NeoKai sends the prompt
 * and parses the NDJSON response stream.
 *
 * ## Communication Protocol
 *
 * Primary: NDJSON output mode
 *   `copilot -p "<prompt>" --output-format json --silent --allow-all [--model <id>]`
 *   - Single subprocess invocation per query
 *   - Parses NDJSON events from stdout
 *   - Session can be resumed with `--resume <sessionId>` for multi-turn
 *
 * ## Event to SDK Message Mapping
 *
 * | Copilot Event              | NeoKai SDK Message             |
 * |----------------------------|--------------------------------|
 * | `assistant.message_delta`  | `stream_event` (text_delta)    |
 * | `assistant.message`        | `SDKAssistantMessage`          |
 * | `result` (exitCode 0)      | `SDKResultMessage` (success)   |
 * | `result` (exitCode != 0)   | `SDKResultMessage` (error)     |
 *
 * @see docs/reports/copilot-cli-capabilities.md
 * @see docs/reports/copilot-message-mapping.md
 */

import type { UUID } from 'crypto';
import type {
	SDKMessage,
	SDKUserMessage,
	SDKAssistantMessage,
	SDKSystemMessage,
	SDKResultMessage,
} from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import { generateUUID } from '@neokai/shared';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Logger } from '../logger.js';

const logger = new Logger('copilot-cli-adapter');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CopilotCliAdapterConfig {
	/** Path to copilot binary (default: 'copilot' from PATH) */
	copilotPath?: string;
	/** Model to use (e.g., 'claude-sonnet-4.6', 'gpt-5.3-codex') */
	model: string;
	/** GitHub auth token; if provided, sets COPILOT_GITHUB_TOKEN env var */
	githubToken?: string;
	/** Working directory for git/file operations */
	cwd?: string;
	/** Resume a previous session by its sessionId */
	resumeSessionId?: string;
	/** Called with the Copilot sessionId from the result event */
	onSessionId?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Internal NDJSON event types
// ---------------------------------------------------------------------------

/** Base shape of every NDJSON event from the Copilot CLI */
export interface CopilotJsonlEvent {
	type: string;
	data: Record<string, unknown>;
	id: string;
	timestamp: string;
	parentId?: string;
	/** Transient/streaming events; not final output */
	ephemeral?: boolean;
}

/** Data payload for `assistant.message_delta` events */
export interface CopilotMessageDeltaData {
	delta?: string;
}

/** A single content block in an `assistant.message` event */
export interface CopilotContentBlock {
	type: string;
	text?: string;
}

/** A tool invocation in an `assistant.message` event */
export interface CopilotToolRequest {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

/** Data payload for `assistant.message` events */
export interface CopilotMessageData {
	content?: CopilotContentBlock[];
	toolRequests?: CopilotToolRequest[];
	reasoningText?: string;
}

/** Data payload for `result` events */
export interface CopilotResultData {
	sessionId?: string;
	exitCode?: number;
	usage?: {
		premiumRequests?: number;
		totalApiDurationMs?: number;
		codeChanges?: {
			additions?: number;
			deletions?: number;
		};
	};
}

// ---------------------------------------------------------------------------
// Helpers: extract prompt text from SDK user message
// ---------------------------------------------------------------------------

/**
 * Extract plain text from an SDK user message for use as the Copilot CLI prompt.
 *
 * - String content is returned as-is.
 * - Array content: text blocks are joined with newlines; non-text blocks are
 *   skipped (base64 images are not supported by the CLI in v1.0.2).
 */
export function extractTextFromUserMessage(message: SDKUserMessage): string {
	const { content } = message.message;

	if (typeof content === 'string') {
		return content;
	}

	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block.type === 'text' && 'text' in block) {
				parts.push((block as { type: 'text'; text: string }).text);
			}
			// Ignore image, tool_result, etc. — CLI handles context natively
		}
		return parts.join('\n');
	}

	return '';
}

// ---------------------------------------------------------------------------
// Helpers: parse NDJSON events
// ---------------------------------------------------------------------------

/**
 * Parse a single line of NDJSON output from the Copilot CLI.
 *
 * Returns null for empty/invalid lines (should be silently skipped).
 */
export function parseCopilotJsonlEvent(line: string): CopilotJsonlEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'type' in parsed &&
			typeof (parsed as Record<string, unknown>).type === 'string'
		) {
			return parsed as CopilotJsonlEvent;
		}
		return null;
	} catch {
		logger.debug('Failed to parse NDJSON line:', trimmed);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Helpers: build NeoKai SDK messages from Copilot events
// ---------------------------------------------------------------------------

/**
 * Build an SDKSystemMessage marking the start of a Copilot CLI session.
 */
export function createCopilotSystemInitMessage(
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
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		output_style: 'default',
		skills: [],
		plugins: [],
		apiKeySource: 'user',
		claude_code_version: 'copilot-cli-adapter',
	};
}

/**
 * Build a `stream_event` SDK message from an `assistant.message_delta` Copilot event.
 */
export function createCopilotStreamEvent(sessionId: string, delta: string): SDKMessage {
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
				text: delta,
			},
		} as unknown as SDKMessage extends { type: 'stream_event' } ? SDKMessage['event'] : never,
	};
}

/**
 * Convert a Copilot `assistant.message` data payload to an SDKAssistantMessage.
 *
 * Maps:
 * - `content[].text` → `{ type: 'text', text }`
 * - `toolRequests[]` → `{ type: 'tool_use', id, name, input }`
 * - `reasoningText` → prepended as `{ type: 'text', text: '<thinking>...</thinking>' }`
 */
export function copilotMessageToSdkAssistant(
	data: CopilotMessageData,
	sessionId: string
): SDKAssistantMessage {
	const messageContent: Array<
		| { type: 'text'; text: string }
		| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	> = [];

	// Prepend reasoning as a text block if present
	if (data.reasoningText) {
		messageContent.push({
			type: 'text',
			text: `<thinking>${data.reasoningText}</thinking>`,
		});
	}

	// Map content blocks
	for (const block of data.content ?? []) {
		if (block.type === 'text' && block.text !== undefined) {
			messageContent.push({ type: 'text', text: block.text });
		}
	}

	// Map tool requests (informational — CLI already executed them)
	for (const req of data.toolRequests ?? []) {
		messageContent.push({
			type: 'tool_use',
			id: req.id,
			name: req.name,
			input: req.arguments ?? {},
		});
	}

	return {
		type: 'assistant',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: null,
		message: {
			role: 'assistant',
			content: messageContent,
		},
	} as SDKAssistantMessage;
}

/**
 * Convert a Copilot `result` event to an SDKResultMessage.
 */
export function copilotResultToSdkResult(
	data: CopilotResultData,
	sessionId: string,
	durationMs: number,
	numTurns: number,
	accumulatedText: string,
	stderrText?: string
): SDKResultMessage {
	const exitCode = data.exitCode ?? 0;
	const success = exitCode === 0;
	const apiDurationMs = data.usage?.totalApiDurationMs ?? durationMs;

	const base = {
		type: 'result' as const,
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		duration_ms: durationMs,
		duration_api_ms: apiDurationMs,
		num_turns: numTurns,
		total_cost_usd: 0, // Cost not available from CLI output
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [] as Array<{
			tool_name: string;
			tool_use_id: string;
			tool_input: Record<string, unknown>;
		}>,
	};

	if (success) {
		return {
			...base,
			subtype: 'success',
			is_error: false,
			result: accumulatedText,
			stop_reason: 'end_turn',
		} as SDKResultMessage;
	}

	const errorMessage = stderrText?.trim() || `Copilot CLI exited with code ${exitCode}`;
	return {
		...base,
		subtype: 'error_during_execution',
		is_error: true,
		errors: [errorMessage],
		stop_reason: errorMessage,
	} as SDKResultMessage;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Main async generator for the Copilot CLI adapter.
 *
 * Spawns the Copilot CLI as a subprocess, parses NDJSON output, and yields
 * NeoKai SDK messages compatible with QueryRunner.
 *
 * IMPORTANT: Like the pi-mono adapter, this consumes exactly ONE message from
 * the prompt generator. The Copilot CLI handles multi-turn tool calling
 * autonomously within a single invocation.
 *
 * @param prompt - AsyncGenerator yielding SDK user messages (only first is used)
 * @param options - Query options (model, systemPrompt, cwd, etc.)
 * @param context - Execution context (signal, sessionId)
 * @param config - Copilot CLI specific configuration
 */
export async function* copilotCliQueryGenerator(
	prompt: AsyncGenerator<SDKUserMessage>,
	options: ProviderQueryOptions,
	context: ProviderQueryContext,
	config: CopilotCliAdapterConfig
): AsyncGenerator<SDKMessage, void, unknown> {
	const startTime = Date.now();

	// Yield system init message first
	yield createCopilotSystemInitMessage(context.sessionId, options);

	// Consume exactly ONE message — the prompt generator blocks after yielding one
	const firstMessage = await prompt.next();
	if (firstMessage.done) {
		logger.warn('Prompt generator yielded no messages');
		yield copilotResultToSdkResult(
			{ exitCode: 1 },
			context.sessionId,
			Date.now() - startTime,
			0,
			'',
			'No user message provided'
		);
		return;
	}

	if (context.signal.aborted) {
		yield copilotResultToSdkResult(
			{ exitCode: 1 },
			context.sessionId,
			Date.now() - startTime,
			0,
			'',
			'Query aborted before start'
		);
		return;
	}

	const userMessage = firstMessage.value;
	const promptText = extractTextFromUserMessage(userMessage);

	if (!promptText.trim()) {
		logger.warn('Empty prompt text extracted from user message');
		yield copilotResultToSdkResult(
			{ exitCode: 1 },
			context.sessionId,
			Date.now() - startTime,
			0,
			'',
			'Empty prompt'
		);
		return;
	}

	// Prepend system prompt if provided
	const fullPrompt = options.systemPrompt
		? `[Context: ${options.systemPrompt}]\n\n${promptText}`
		: promptText;

	// Build CLI arguments
	const copilotPath = config.copilotPath || 'copilot';
	const args = buildCliArgs(fullPrompt, config, options);

	// Build environment (pass GitHub token if provided)
	const childEnv = buildChildEnv(config);

	logger.debug(`Spawning: ${copilotPath} ${args.slice(0, 3).join(' ')} ...`);

	// Spawn the Copilot CLI process
	const child = spawn(copilotPath, args, {
		cwd: config.cwd || options.cwd,
		env: childEnv,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	// Set up abort handler
	const abortHandler = () => {
		logger.debug('Aborting Copilot CLI subprocess');
		child.kill('SIGTERM');
	};
	context.signal.addEventListener('abort', abortHandler);

	// Collect stderr for error reporting
	const stderrChunks: Buffer[] = [];
	child.stderr?.on('data', (chunk: Buffer) => {
		stderrChunks.push(chunk);
	});

	// Parse NDJSON from stdout
	const readline = createInterface({ input: child.stdout!, crlfDelay: Infinity });

	let accumulatedText = '';
	let numTurns = 0;
	let resultData: CopilotResultData = {};
	const processErrors: Error[] = [];
	let hasAssistantMessage = false;

	// We yield messages as we parse the stream
	for await (const line of readline) {
		if (context.signal.aborted) {
			child.kill('SIGTERM');
			break;
		}

		const event = parseCopilotJsonlEvent(line);
		if (!event) continue;

		switch (event.type) {
			case 'assistant.turn_start':
				numTurns++;
				break;

			case 'assistant.message_delta': {
				// Streaming text token
				const deltaData = event.data as CopilotMessageDeltaData;
				const delta = deltaData.delta ?? '';
				if (delta) {
					accumulatedText += delta;
					yield createCopilotStreamEvent(context.sessionId, delta);
				}
				break;
			}

			case 'assistant.message': {
				// Final complete message for this turn
				const msgData = event.data as CopilotMessageData;
				hasAssistantMessage = true;

				// Collect text from content blocks for accumulated result
				if (msgData.content) {
					for (const block of msgData.content) {
						if (block.type === 'text' && block.text) {
							// Text was already accumulated via deltas; just ensure we have something
							if (!accumulatedText) {
								accumulatedText = block.text;
							}
						}
					}
				}

				yield copilotMessageToSdkAssistant(msgData, context.sessionId);
				break;
			}

			case 'result': {
				resultData = event.data as CopilotResultData;

				// Notify caller of session ID for potential multi-turn resumption
				if (resultData.sessionId && config.onSessionId) {
					config.onSessionId(resultData.sessionId);
				}
				break;
			}

			// These events are informational; no NeoKai equivalent needed
			case 'user.message':
			case 'assistant.reasoning_delta':
			case 'assistant.reasoning':
			case 'assistant.turn_end':
				break;

			default:
				logger.debug(`Unknown Copilot CLI event type: ${event.type}`);
		}
	}

	// Wait for process to exit
	const exitCode = await new Promise<number>((resolve) => {
		if (child.exitCode !== null) {
			resolve(child.exitCode);
			return;
		}
		child.on('exit', (code) => resolve(code ?? 1));
		child.on('error', (err: Error) => {
			processErrors.push(err);
			resolve(1);
		});
	});

	// Cleanup
	context.signal.removeEventListener('abort', abortHandler);

	if (context.signal.aborted) {
		yield copilotResultToSdkResult(
			{ exitCode: 1 },
			context.sessionId,
			Date.now() - startTime,
			numTurns,
			accumulatedText,
			'Query aborted'
		);
		return;
	}

	if (processErrors.length > 0) {
		const errMsg = processErrors[0]?.message ?? 'Unknown process error';
		yield copilotResultToSdkResult(
			{ exitCode: 1 },
			context.sessionId,
			Date.now() - startTime,
			numTurns,
			accumulatedText,
			`Copilot CLI process error: ${errMsg}`
		);
		return;
	}

	const stderrText = Buffer.concat(stderrChunks).toString('utf-8');

	// If no assistant message was received but no error either, synthesize result
	if (!hasAssistantMessage && exitCode === 0) {
		logger.warn('Copilot CLI completed without emitting assistant.message');
	}

	// Prefer exitCode from process over result event if they conflict
	const effectiveExitCode = exitCode !== 0 ? exitCode : (resultData.exitCode ?? 0);

	yield copilotResultToSdkResult(
		{ ...resultData, exitCode: effectiveExitCode },
		context.sessionId,
		Date.now() - startTime,
		numTurns || 1,
		accumulatedText,
		stderrText || undefined
	);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the argument array for the copilot CLI subprocess.
 */
function buildCliArgs(
	prompt: string,
	config: CopilotCliAdapterConfig,
	options: ProviderQueryOptions
): string[] {
	const args: string[] = [
		'-p',
		prompt,
		'--output-format',
		'json',
		'--silent',
		'--allow-all',
		'--no-auto-update',
		'--no-ask-user',
	];

	// Use the configured model; fall back to options.model
	const model = config.model || options.model;
	if (model) {
		args.push('--model', model);
	}

	// Resume a previous session for multi-turn conversations
	if (config.resumeSessionId) {
		args.push('--resume', config.resumeSessionId);
	}

	return args;
}

/**
 * Build the environment for the copilot CLI subprocess.
 *
 * Injects GitHub token if provided, using the Copilot CLI's preferred env var.
 */
function buildChildEnv(config: CopilotCliAdapterConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };

	if (config.githubToken) {
		// COPILOT_GITHUB_TOKEN takes highest precedence
		env.COPILOT_GITHUB_TOKEN = config.githubToken;
	}

	return env;
}
