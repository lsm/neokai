/**
 * SDK Message Renderer - Routes SDK messages to appropriate renderers
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import type {
  PendingUserQuestion,
  QuestionDraftResponse,
  ResolvedQuestion,
} from "@liuboer/shared";
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKSystemInit,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
  isUserVisibleMessage,
} from "@liuboer/shared/sdk/type-guards";

// Component imports
import { SDKAssistantMessage } from "./SDKAssistantMessage.tsx";
import { SDKResultMessage } from "./SDKResultMessage.tsx";
import { SDKSystemMessage } from "./SDKSystemMessage.tsx";
import { SDKToolProgressMessage } from "./SDKToolProgressMessage.tsx";
import { SDKUserMessage } from "./SDKUserMessage.tsx";
import { AuthStatusCard } from "./tools/index.ts";

type SystemInitMessage = Extract<
  SDKMessage,
  { type: "system"; subtype: "init" }
>;

interface Props {
  message: SDKMessage;
  toolResultsMap?: Map<string, unknown>;
  toolInputsMap?: Map<string, unknown>;
  subagentMessagesMap?: Map<string, SDKMessage[]>;
  sessionInfo?: SystemInitMessage; // Optional session init info to attach to user messages
  // Question handling props for inline QuestionPrompt rendering
  sessionId?: string;
  resolvedQuestions?: Map<string, ResolvedQuestion>;
  pendingQuestion?: PendingUserQuestion | null;
  onQuestionResolved?: (
    state: "submitted" | "cancelled",
    responses: QuestionDraftResponse[],
  ) => void;
}

/**
 * Check if message is a sub-agent message (has parent_tool_use_id)
 * Sub-agent messages are shown inside SubagentBlock, not as separate messages
 */
function isSubagentMessage(message: SDKMessage): boolean {
  const msgWithParent = message as SDKMessage & {
    parent_tool_use_id?: string | null;
  };
  return !!msgWithParent.parent_tool_use_id;
}

/**
 * Main SDK message renderer - routes to appropriate sub-renderer
 */
export function SDKMessageRenderer({
  message,
  toolResultsMap,
  toolInputsMap,
  subagentMessagesMap,
  sessionInfo,
  sessionId,
  resolvedQuestions,
  pendingQuestion,
  onQuestionResolved,
}: Props) {
  // Skip messages that shouldn't be shown to user (e.g., stream events)
  if (!isUserVisibleMessage(message)) {
    return null;
  }

  // Skip session init messages - they're now shown as indicators attached to user messages
  if (isSDKSystemInit(message)) {
    return null;
  }

  // Skip sub-agent messages - they're now shown inside SubagentBlock
  if (isSubagentMessage(message)) {
    return null;
  }

  // Route to appropriate renderer based on message type
  // Handle user replay messages (slash command responses) first
  if (isSDKUserMessageReplay(message)) {
    return (
      <SDKUserMessage
        message={message}
        sessionInfo={sessionInfo}
        isReplay={true}
      />
    );
  }

  if (isSDKUserMessage(message)) {
    return <SDKUserMessage message={message} sessionInfo={sessionInfo} />;
  }

  if (isSDKAssistantMessage(message)) {
    return (
      <SDKAssistantMessage
        message={message}
        toolResultsMap={toolResultsMap}
        subagentMessagesMap={subagentMessagesMap}
        sessionId={sessionId}
        resolvedQuestions={resolvedQuestions}
        pendingQuestion={pendingQuestion}
        onQuestionResolved={onQuestionResolved}
      />
    );
  }

  if (isSDKResultMessage(message)) {
    return <SDKResultMessage message={message} />;
  }

  if (isSDKSystemMessage(message)) {
    return <SDKSystemMessage message={message} />;
  }

  if (isSDKToolProgressMessage(message)) {
    const toolInput = toolInputsMap?.get(message.tool_use_id);
    return <SDKToolProgressMessage message={message} toolInput={toolInput} />;
  }

  if (isSDKAuthStatusMessage(message)) {
    return (
      <AuthStatusCard
        isAuthenticating={message.isAuthenticating}
        output={message.output}
        error={message.error}
        variant="default"
      />
    );
  }

  // Fallback for unknown message types (shouldn't happen, but safe)
  return (
    <div class="p-3 bg-gray-100 dark:bg-gray-800 rounded">
      <div class="text-xs text-gray-600 dark:text-gray-400 mb-1">
        Unknown message type: {message.type}
      </div>
      <details>
        <summary class="text-xs cursor-pointer text-gray-500">
          Show raw data
        </summary>
        <pre class="text-xs mt-2 overflow-x-auto">
          {JSON.stringify(message, null, 2)}
        </pre>
      </details>
    </div>
  );
}
