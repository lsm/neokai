import { useState } from "preact/hooks";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export default function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [content, setContent] = useState("");

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (content.trim() && !disabled) {
      onSend(content);
      setContent("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div class="bg-white border-t border-gray-200 p-4">
      <form onSubmit={handleSubmit} class="max-w-4xl mx-auto">
        <div class="flex items-end space-x-3">
          <div class="flex-1">
            <textarea
              value={content}
              onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              disabled={disabled}
              rows={3}
              class="w-full px-4 py-3 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>
          <button
            type="submit"
            disabled={disabled || !content.trim()}
            class="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {disabled ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
