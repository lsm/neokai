/**
 * Codex CLI Adapter
 *
 * Provides integration with the OpenAI Codex CLI (`codex exec --json`) as a
 * subprocess backend. Translates the Codex JSONL event stream to NeoKai SDK
 * messages, allowing NeoKai sessions to delegate autonomous execution to Codex.
 *
 * ARCHITECTURAL NOTE: This adapter uses Codex CLI as a subprocess. Unlike the pi-mono
 * adapter which uses NeoKai's tool execution system, Codex CLI executes tools (file
 * operations, shell commands) AUTONOMOUSLY within its own process. NeoKai's tool
 * definitions from ProviderQueryOptions.tools are NOT passed to Codex — they are ignored.
 * This means:
 * - Codex makes file changes directly in the working directory
 * - NeoKai cannot intercept, log, or control individual tool calls
 * - This is appropriate when delegating a complete autonomous task to Codex
 * - For transparent model access with NeoKai tool control, use the pi-mono adapter instead
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
} from '@neokai/shared/provider/query-types';
import { generateUUID } from '@neokai/shared';
import { Logger } from '../logger.js';

const logger = new Logger('codex-cli-adapter');

// ---------------------------------------------------------------------------
// Codex CLI event types (from `codex exec --json` JSONL stream)
// ---------------------------------------------------------------------------

type CodexItem =
	| { id: string; type: 'agent_message'; text: string }
	| { id: string; type: 'reasoning'; text: string }
	| {
			id: string;
			type: 'command_execution';
			command: string;
			shell?: string;
			output?: string;
			exit_code?: number;
	  }
	| { id: string; type: 'file_change'; path: string; operation: 'create' | 'modify' | 'delete' }
	| { id: string; type: 'web_search'; query: string; results?: unknown[] }
	| { id: string; type: 'mcp_tool_call'; tool: string; input?: unknown; output?: unknown }
	| { id: string; type: 'plan_update'; plan: string };

type CodexEvent =
	| { type: 'thread.started'; thread_id: string }
	| { type: 'turn.started' }
	| { type: 'item.started'; item: CodexItem }
	| { type: 'item.delta'; item_id: string; delta: { type: 'text_delta'; text: string } }
	| { type: 'item.completed'; item: CodexItem }
	| { type: 'turn.completed'; usage?: { input_tokens: number; output_tokens: number } }
	| { type: 'error'; message: string; code?: string };

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface CodexCliAdapterConfig {
	/** Path to the codex binary. Defaults to 'codex'. */
	codexPath?: string;
	/** Model ID to pass to codex (e.g. 'gpt-5.4'). */
	model: string;
	/** API key — written to OPENAI_API_KEY / CODEX_API_KEY in the subprocess env. */
	apiKey?: string;
	/** Sandbox level for Codex. Defaults to 'workspace-write'. */
	sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
	/** When Codex should ask for approval. Defaults to 'never' for autonomous operation. */
	approvalMode?: 'untrusted' | 'on-request' | 'never';
}

// ---------------------------------------------------------------------------
// Helpers — message factories (mirrors pimono-adapter style)
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
		// Codex ignores NeoKai tool definitions — report empty list to make it explicit
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		output_style: 'default',
		skills: [],
		plugins: [],
		apiKeySource: 'user',
		claude_code_version: 'codex-cli-adapter',
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
	usage?: { input_tokens: number; output_tokens: number }
): SDKResultMessage {
	const base = {
		type: 'result' as const,
		duration_ms: durationMs,
		duration_api_ms: durationMs,
		num_turns: numTurns,
		total_cost_usd: 0,
		usage: {
			input_tokens: usage?.input_tokens ?? 0,
			output_tokens: usage?.output_tokens ?? 0,
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
// PATH helper
// ---------------------------------------------------------------------------

/**
 * Check if the `codex` binary (or a custom path) is available.
 * Returns the resolved executable path, or null if not found.
 */
export function findCodexCli(codexPath: string = 'codex'): string | null {
	try {
		const result = Bun.spawnSync(['which', codexPath], { stderr: 'pipe' });
		if (result.exitCode === 0) {
			const found = result.stdout.toString().trim();
			return found.length > 0 ? found : codexPath;
		}
		return null;
	} catch {
		return null;
	}
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
// Main generator
// ---------------------------------------------------------------------------

/**
 * Codex CLI query generator.
 *
 * Spawns `codex exec --json` as a subprocess and translates the JSONL event
 * stream into NeoKai SDK messages. Only the first user message from `prompt` is
 * consumed — matching the pattern used by piMonoQueryGenerator.
 *
 * NOTE: NeoKai tool definitions in `options.tools` are intentionally ignored.
 * Codex executes tools autonomously inside its own process.
 */
export async function* codexExecQueryGenerator(
	prompt: AsyncGenerator<SDKUserMessage>,
	options: ProviderQueryOptions,
	context: ProviderQueryContext,
	config: CodexCliAdapterConfig
): AsyncGenerator<SDKMessage, void, unknown> {
	const startTime = Date.now();
	let turnCount = 0;
	let finalUsage: { input_tokens: number; output_tokens: number } | undefined;

	// CRITICAL: Only consume ONE message from the prompt generator.
	const firstMessage = await prompt.next();
	if (firstMessage.done) {
		logger.warn('Codex adapter: prompt generator yielded no messages');
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

	const userMessage = firstMessage.value;
	const promptText = extractTextFromUserMessage(userMessage);

	if (!promptText.trim()) {
		logger.warn('Codex adapter: user message contains no text');
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

	// Build the codex exec command
	const codexBin = config.codexPath ?? 'codex';
	const sandbox = config.sandbox ?? 'workspace-write';
	const approvalMode = config.approvalMode ?? 'never';

	const args: string[] = [
		'exec',
		'--json',
		'--model',
		config.model,
		'--sandbox',
		sandbox,
		'--ask-for-approval',
		approvalMode,
		promptText,
	];

	// Build subprocess environment
	const subEnv: Record<string, string> = { ...process.env } as Record<string, string>;
	if (config.apiKey) {
		subEnv['OPENAI_API_KEY'] = config.apiKey;
		subEnv['CODEX_API_KEY'] = config.apiKey;
	}

	logger.debug(`Codex CLI: spawning ${codexBin} exec --json --model ${config.model}`);
	logger.debug(
		'NOTE: Codex executes tools autonomously — NeoKai tool definitions are NOT forwarded'
	);

	// spawn with stdout/stderr as 'pipe' — Bun types these as ReadableStream when piped
	type PipedProc = {
		readonly stdout: ReadableStream<Uint8Array>;
		readonly stderr: ReadableStream<Uint8Array>;
		readonly exited: Promise<number>;
		kill(): void;
	};

	let proc: PipedProc;
	try {
		proc = Bun.spawn([codexBin, ...args], {
			cwd: options.cwd,
			env: subEnv,
			stdout: 'pipe',
			stderr: 'pipe',
		}) as unknown as PipedProc;
	} catch (spawnError) {
		const msg = spawnError instanceof Error ? spawnError.message : 'Failed to spawn codex';
		logger.error('Codex CLI: spawn failed:', spawnError);
		yield createResultMessage(context.sessionId, false, Date.now() - startTime, turnCount, '', msg);
		return;
	}

	// Abort signal integration — kill the subprocess if the session is aborted
	const abortHandler = () => {
		logger.debug('Codex CLI: aborting subprocess due to signal');
		proc.kill();
	};
	context.signal.addEventListener('abort', abortHandler, { once: true });

	// Yield system init message before streaming events
	yield createSystemInitMessage(context.sessionId, options);

	// Track per-item state for tool progress pairing
	const toolStartTimes = new Map<string, number>();
	// Accumulated assistant text for the final result message
	let accumulatedText = '';
	let processError: string | undefined;

	try {
		// Read stdout line by line
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			if (context.signal.aborted) {
				break;
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			const lines = buffer.split('\n');
			// Keep the last (potentially incomplete) chunk in the buffer
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}

				let event: CodexEvent;
				try {
					event = JSON.parse(trimmed) as CodexEvent;
				} catch {
					logger.debug('Codex CLI: skipping non-JSON line:', trimmed);
					continue;
				}

				const messages = translateCodexEvent(event, context.sessionId, toolStartTimes);
				for (const msg of messages) {
					if (msg.type === 'assistant') {
						// Track accumulated text from assistant messages
						const assistantMsg = msg as SDKAssistantMessage;
						const msgContent = assistantMsg.message.content;
						if (Array.isArray(msgContent)) {
							for (const block of msgContent) {
								if (block.type === 'text') {
									accumulatedText += block.text;
								}
							}
						}
					}
					if (event.type === 'turn.completed' && 'usage' in event && event.usage) {
						finalUsage = event.usage;
					}
					yield msg;
				}

				if (event.type === 'turn.completed') {
					turnCount++;
					if (event.usage) {
						finalUsage = event.usage;
					}
				}

				if (event.type === 'error') {
					processError = event.message;
					logger.error('Codex CLI error event:', event.message);
				}
			}
		}

		// Process any remaining buffered data
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer.trim()) as CodexEvent;
				const messages = translateCodexEvent(event, context.sessionId, toolStartTimes);
				for (const msg of messages) {
					yield msg;
				}
				if (event.type === 'turn.completed' && event.usage) {
					finalUsage = event.usage;
					turnCount++;
				}
				if (event.type === 'error') {
					processError = event.message;
				}
			} catch {
				// Ignore trailing non-JSON
			}
		}

		// Wait for process to exit
		const exitCode = await proc.exited;
		logger.debug(`Codex CLI: process exited with code ${exitCode}`);

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

		if (processError) {
			yield createResultMessage(
				context.sessionId,
				false,
				Date.now() - startTime,
				turnCount,
				'',
				processError,
				finalUsage
			);
			return;
		}

		if (exitCode !== 0) {
			// Collect stderr for context
			let stderrText = '';
			try {
				stderrText = (await new Response(proc.stderr).text()).trim();
			} catch {
				// Ignore stderr read errors
			}

			const errMsg = stderrText
				? `Codex exited with code ${exitCode}: ${stderrText}`
				: `Codex exited with code ${exitCode}`;

			yield createResultMessage(
				context.sessionId,
				false,
				Date.now() - startTime,
				turnCount,
				'',
				errMsg,
				finalUsage
			);
			return;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error reading codex output';
		logger.error('Codex CLI: error reading stdout:', err);
		yield createResultMessage(context.sessionId, false, Date.now() - startTime, turnCount, '', msg);
		return;
	} finally {
		context.signal.removeEventListener('abort', abortHandler);
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

// ---------------------------------------------------------------------------
// Codex event → SDK message translation
// ---------------------------------------------------------------------------

function translateCodexEvent(
	event: CodexEvent,
	sessionId: string,
	toolStartTimes: Map<string, number>
): SDKMessage[] {
	const messages: SDKMessage[] = [];

	switch (event.type) {
		case 'thread.started':
			logger.debug(`Codex thread started: ${event.thread_id}`);
			// POC LIMITATION: thread_id is not persisted to NeoKai session metadata.
			// Each new user turn spawns a fresh Codex thread with no conversation history.
			// To support multi-turn, persist event.thread_id and pass it via
			// `codex exec resume <thread_id>` on subsequent turns.
			logger.warn(
				`[codex-cli-adapter] thread_id=${event.thread_id} not persisted — multi-turn is not supported in this POC`
			);
			break;

		case 'turn.started':
			logger.debug('Codex turn started');
			break;

		case 'item.delta':
			if (event.delta.type === 'text_delta') {
				messages.push(createStreamEvent(sessionId, event.delta.text));
			}
			break;

		case 'item.started': {
			const startItem = event.item;
			if (
				startItem.type === 'command_execution' ||
				startItem.type === 'file_change' ||
				startItem.type === 'web_search' ||
				startItem.type === 'mcp_tool_call'
			) {
				toolStartTimes.set(startItem.id, Date.now());
				const toolName = resolveToolName(startItem);
				messages.push(createToolProgressMessage(sessionId, toolName, startItem.id, 0));
			}
			break;
		}

		case 'item.completed': {
			const completedItem = event.item;

			if (completedItem.type === 'agent_message') {
				// Complete assistant message — emit stream event for any text not already streamed
				// and the assistant message itself
				if (completedItem.text) {
					messages.push(createAssistantMessage(sessionId, completedItem.text));
				}
			} else if (
				completedItem.type === 'command_execution' ||
				completedItem.type === 'file_change' ||
				completedItem.type === 'web_search' ||
				completedItem.type === 'mcp_tool_call'
			) {
				const startedAt = toolStartTimes.get(completedItem.id);
				const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
				toolStartTimes.delete(completedItem.id);
				const toolName = resolveToolName(completedItem);
				messages.push(createToolProgressMessage(sessionId, toolName, completedItem.id, elapsed));
			} else if (completedItem.type === 'reasoning') {
				// Emit reasoning as a stream event so it appears inline
				if (completedItem.text) {
					messages.push(createStreamEvent(sessionId, `<thinking>${completedItem.text}</thinking>`));
				}
			}
			break;
		}

		case 'turn.completed':
			logger.debug('Codex turn completed', event.usage);
			break;

		case 'error':
			logger.error('Codex error event:', event.message, event.code);
			break;

		default:
			logger.debug('Codex CLI: unhandled event type');
	}

	return messages;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function resolveToolName(item: CodexItem): string {
	switch (item.type) {
		case 'command_execution':
			return 'command_execution';
		case 'file_change':
			return `file_change:${item.operation}`;
		case 'web_search':
			return 'web_search';
		case 'mcp_tool_call':
			return `mcp:${item.tool}`;
		default:
			return item.type;
	}
}
