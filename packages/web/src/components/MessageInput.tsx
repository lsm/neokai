import { useEffect, useRef, useState } from "preact/hooks";
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
      const newHeight = Math.min(textarea.scrollHeight, 300);
      textarea.style.height = `${newHeight}px`;
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
    // Cmd+Enter or Ctrl+Enter to send
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
        {/* Input Group */}
        <div class="relative rounded-[28px] border border-dark-700/50 bg-dark-800/40 backdrop-blur-sm shadow-lg transition-all focus-within:border-blue-500/40 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:bg-dark-800/60">
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask, search, or make anything..."
            disabled={disabled}
            maxLength={maxChars}
            class={cn(
              "w-full px-5 pt-4 pb-14 text-gray-100 resize-none bg-transparent",
              "placeholder:text-gray-500",
              "focus:outline-none",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
            style={{
              minHeight: "120px",
              maxHeight: "300px",
              lineHeight: "1.5",
            }}
          />

          {/* Character Counter */}
          {showCharCount && (
            <div
              class={cn(
                "absolute top-3 right-4 text-xs",
                charCount >= maxChars ? "text-red-400" : "text-gray-500",
              )}
            >
              {charCount}/{maxChars}
            </div>
          )}

          {/* Bottom Toolbar */}
          <div class="absolute bottom-0 left-0 right-0 px-4 py-3 flex items-center gap-3 border-t border-dark-700/30">
            {/* Attachment Button */}
            <button
              type="button"
              class="p-2 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-dark-700/50 transition-all"
              title="Attach file"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>

            <div class="flex-1" />

            {/* Send Button */}
            <button
              type="submit"
              disabled={disabled || !content.trim()}
              title="Send message (⌘+Enter)"
              class={cn(
                "p-2.5 rounded-full transition-all flex items-center justify-center",
                disabled || !content.trim()
                  ? "bg-dark-700 text-gray-600 cursor-not-allowed"
                  : "bg-blue-500 text-white hover:bg-blue-600 active:scale-95",
              )}
            >
              <svg
                class="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M5 10l7-7m0 0l7 7m-7-7v18"
                />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
