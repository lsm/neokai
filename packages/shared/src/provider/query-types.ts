/**
 * Provider Query Types
 *
 * Types for custom provider query generation.
 * Used by providers that bypass the Claude Agent SDK (e.g., OpenAI, GitHub Copilot).
 */

/**
 * Tool definition for custom providers
 */
export interface ToolDefinition {
	/** Tool name */
	name: string;
	/** Tool description */
	description: string;
	/** JSON Schema for input parameters */
	inputSchema: Record<string, unknown>;
}

/**
 * Options for creating a provider query
 */
export interface ProviderQueryOptions {
	/** Model ID to use */
	model: string;
	/** System prompt to prepend to the conversation */
	systemPrompt?: string;
	/** Available tools for the model to use */
	tools: ToolDefinition[];
	/** Working directory for tool execution */
	cwd: string;
	/** Maximum number of turns */
	maxTurns: number;
	/** Permission mode for tool execution */
	permissionMode?: string;
	/** API key for authentication (OAuth providers retrieve via getApiKey()) */
	apiKey?: string;
}

/**
 * Context for provider query execution
 */
export interface ProviderQueryContext {
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Session ID for logging/tracing */
	sessionId: string;
	/** Whether this is a custom query provider (bypasses SDK) */
	usesCustomQuery?: boolean;
}

/**
 * Message content block types for custom provider translation
 */
export type CustomProviderContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| {
			type: 'tool_result';
			tool_use_id: string;
			content: string | CustomProviderContentBlock[];
			is_error?: boolean;
	  };

/**
 * User message format for custom provider translation
 */
export interface CustomProviderUserMessage {
	role: 'user';
	content: string | CustomProviderContentBlock[];
}

/**
 * Assistant message format for custom provider translation
 */
export interface CustomProviderAssistantMessage {
	role: 'assistant';
	content: string | CustomProviderContentBlock[];
}

/**
 * Message format for custom provider conversations
 */
export type CustomProviderMessage = CustomProviderUserMessage | CustomProviderAssistantMessage;
