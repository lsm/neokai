/**
 * copilot-anthropic — public surface area
 *
 * Everything needed by:
 *  - factory.ts (provider registration)
 *  - test files (white-box testing of internals)
 */

export { CopilotAnthropicProvider } from './provider.js';
export { startEmbeddedServer, type EmbeddedServer } from './server.js';

// Exported for unit tests only
export { runSessionStreaming, resumeSessionStreaming, type StreamingOutcome } from './streaming.js';
export { formatAnthropicPrompt, extractSystemText, extractToolResultIds } from './prompt.js';
export { ToolBridgeRegistry, mapAnthropicToolsToSdkTools } from './tool-bridge.js';
export { ConversationManager } from './conversation.js';
