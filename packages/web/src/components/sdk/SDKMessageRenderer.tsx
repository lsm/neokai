/**
 * SDK Message Renderer - Routes SDK messages to appropriate renderers
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKStreamEvent,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isSDKUserMessage,
  isUserVisibleMessage,
} from "@liuboer/shared/sdk/type-guards";

// Component imports
import { SDKAssistantMessage } from "./SDKAssistantMessage.tsx";
import { SDKResultMessage } from "./SDKResultMessage.tsx";
import { SDKSystemMessage } from "./SDKSystemMessage.tsx";
import { SDKToolProgressMessage } from "./SDKToolProgressMessage.tsx";
import { SDKUserMessage } from "./SDKUserMessage.tsx";

interface Props {
  message: SDKMessage;
  toolResultsMap?: Map<string, any>;
}

/**
 * Main SDK message renderer - routes to appropriate sub-renderer
 */
export function SDKMessageRenderer({ message, toolResultsMap }: Props) {
  // Skip messages that shouldn't be shown to user (e.g., stream events, replays)
  if (!isUserVisibleMessage(message)) {
    return null;
  }

  // Route to appropriate renderer based on message type
  if (isSDKUserMessage(message)) {
    return <SDKUserMessage message={message} />;
  }

  if (isSDKAssistantMessage(message)) {
    return <SDKAssistantMessage message={message} toolResultsMap={toolResultsMap} />;
  }

  if (isSDKResultMessage(message)) {
    return <SDKResultMessage message={message} />;
  }

  if (isSDKSystemMessage(message)) {
    return <SDKSystemMessage message={message} />;
  }

  if (isSDKToolProgressMessage(message)) {
    return <SDKToolProgressMessage message={message} />;
  }

  if (isSDKAuthStatusMessage(message)) {
    return (
      <div class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded text-sm">
        <div class="font-medium text-blue-900 dark:text-blue-100 mb-1">
          {message.isAuthenticating ? "Authenticating..." : "Authentication Complete"}
        </div>
        {message.output && message.output.length > 0 && (
          <div class="text-blue-700 dark:text-blue-300 text-xs whitespace-pre-wrap">
            {message.output.join("\n")}
          </div>
        )}
        {message.error && (
          <div class="text-red-600 dark:text-red-400 text-xs mt-1">
            Error: {message.error}
          </div>
        )}
      </div>
    );
  }

  // Fallback for unknown message types (shouldn't happen, but safe)
  return (
    <div class="p-3 bg-gray-100 dark:bg-gray-800 rounded">
      <div class="text-xs text-gray-600 dark:text-gray-400 mb-1">
        Unknown message type: {message.type}
      </div>
      <details>
        <summary class="text-xs cursor-pointer text-gray-500">Show raw data</summary>
        <pre class="text-xs mt-2 overflow-x-auto">
          {JSON.stringify(message, null, 2)}
        </pre>
      </details>
    </div>
  );
}
