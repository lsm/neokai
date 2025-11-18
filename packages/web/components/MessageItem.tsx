import type { Message } from "@liuboer/shared";

interface MessageItemProps {
  message: Message;
}

export default function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === "user";

  return (
    <div class="flex items-start space-x-3">
      {/* Avatar */}
      <div
        class={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0 ${
          isUser ? "bg-blue-600" : "bg-purple-600"
        }`}
      >
        {isUser ? "U" : "AI"}
      </div>

      {/* Content */}
      <div class="flex-1">
        <div class="flex items-center space-x-2 mb-1">
          <span class="font-medium text-sm text-gray-900">
            {isUser ? "You" : "Claude"}
          </span>
          <span class="text-xs text-gray-500">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <div class="bg-white rounded-lg p-4 shadow-sm">
          {/* Thinking */}
          {message.thinking && (
            <details class="mb-3 text-sm text-gray-600 bg-gray-50 rounded p-2">
              <summary class="cursor-pointer font-medium">Thinking...</summary>
              <div class="mt-2 whitespace-pre-wrap">{message.thinking}</div>
            </details>
          )}

          {/* Main Content */}
          <div class="prose prose-sm max-w-none whitespace-pre-wrap">
            {message.content}
          </div>

          {/* Tool Calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div class="mt-3 space-y-2">
              {message.toolCalls.map((toolCall) => (
                <details
                  key={toolCall.id}
                  class="text-sm bg-gray-50 rounded p-2"
                >
                  <summary class="cursor-pointer font-medium text-gray-700">
                    <span
                      class={`inline-block w-2 h-2 rounded-full mr-2 ${
                        toolCall.status === "success"
                          ? "bg-green-500"
                          : toolCall.status === "error"
                          ? "bg-red-500"
                          : "bg-yellow-500"
                      }`}
                    >
                    </span>
                    {toolCall.tool}
                    {toolCall.duration && (
                      <span class="text-gray-500 ml-2">
                        ({toolCall.duration}ms)
                      </span>
                    )}
                  </summary>
                  <div class="mt-2 pl-4 space-y-2">
                    <div>
                      <div class="text-xs font-medium text-gray-500 mb-1">
                        Input:
                      </div>
                      <pre class="text-xs bg-white p-2 rounded overflow-x-auto">
                        {JSON.stringify(toolCall.input, null, 2)}
                      </pre>
                    </div>
                    {toolCall.output && (
                      <div>
                        <div class="text-xs font-medium text-gray-500 mb-1">
                          Output:
                        </div>
                        <pre class="text-xs bg-white p-2 rounded overflow-x-auto">
                          {JSON.stringify(toolCall.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    {toolCall.error && (
                      <div class="text-xs text-red-600">
                        Error: {toolCall.error}
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* Artifacts */}
          {message.artifacts && message.artifacts.length > 0 && (
            <div class="mt-3 space-y-2">
              {message.artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  class="border border-gray-200 rounded-lg overflow-hidden"
                >
                  <div class="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700">
                    {artifact.title}
                  </div>
                  <pre class="p-3 overflow-x-auto text-sm bg-gray-900 text-gray-100">
                    <code>{artifact.content}</code>
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
