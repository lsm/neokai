import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./ui/Button.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { cn } from "../lib/utils.ts";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export default function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxChars = 10000;

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
    }
  }, [content]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
    } else if (e.key === "Escape") {
      setContent("");
      textareaRef.current?.blur();
    }
  };

  const charCount = content.length;
  const showCharCount = charCount > maxChars * 0.8;

  return (
    <div class="bg-dark-850 border-t border-dark-700 p-4">
      <form onSubmit={handleSubmit} class="max-w-4xl mx-auto">
        <div class="relative">
          <textarea
            ref={textareaRef}
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line, Esc to clear)"
            disabled={disabled}
            maxLength={maxChars}
            class={cn(
              "w-full px-4 py-3 bg-dark-800 border-2 border-dark-700 text-gray-100 rounded-lg resize-none",
              "placeholder:text-gray-500",
              "focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "transition-colors",
            )}
            style={{ minHeight: "60px", maxHeight: "300px" }}
          />

          {/* Character Counter */}
          {showCharCount && (
            <div
              class={cn(
                "absolute bottom-2 left-3 text-xs",
                charCount >= maxChars ? "text-red-400" : "text-gray-500",
              )}
            >
              {charCount}/{maxChars}
            </div>
          )}
        </div>

        <div class="flex items-center justify-between mt-3">
          <div class="flex items-center gap-2">
            {/* Attachment button placeholder */}
            <IconButton
              size="sm"
              title="Attach file (coming soon)"
              disabled
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                />
              </svg>
            </IconButton>

            <span class="text-xs text-gray-500">
              Shortcuts: <kbd class="px-1.5 py-0.5 bg-dark-700 rounded text-gray-400">↵</kbd> send, <kbd class="px-1.5 py-0.5 bg-dark-700 rounded text-gray-400">⇧↵</kbd> new line
            </span>
          </div>

          <Button
            type="submit"
            disabled={disabled || !content.trim()}
            loading={disabled}
            icon={
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            }
          >
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
