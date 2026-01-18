/**
 * useCommandAutocomplete Hook
 *
 * Handles slash command detection, filtering, and keyboard navigation.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import { useState, useEffect, useCallback } from "preact/hooks";
import { slashCommandsSignal } from "../lib/signals.ts";

export interface UseCommandAutocompleteOptions {
  content: string;
  onSelect: (command: string) => void;
}

export interface UseCommandAutocompleteResult {
  showAutocomplete: boolean;
  filteredCommands: string[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleSelect: (command: string) => void;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  close: () => void;
}

/**
 * Hook for managing slash command autocomplete
 */
export function useCommandAutocomplete({
  content,
  onSelect,
}: UseCommandAutocompleteOptions): UseCommandAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<string[]>([]);

  // Detect slash commands
  useEffect(() => {
    const trimmedContent = content.trimStart();

    if (
      trimmedContent.startsWith("/") &&
      slashCommandsSignal.value.length > 0
    ) {
      const query = trimmedContent.slice(1).toLowerCase();
      const filtered = slashCommandsSignal.value.filter((cmd) =>
        cmd.toLowerCase().includes(query),
      );

      setFilteredCommands(filtered);
      setShowAutocomplete(filtered.length > 0);
      setSelectedIndex(0);
    } else {
      setShowAutocomplete(false);
      setFilteredCommands([]);
    }
  }, [content]);

  const close = useCallback(() => {
    setShowAutocomplete(false);
  }, []);

  const handleSelect = useCallback(
    (command: string) => {
      onSelect(command);
      setShowAutocomplete(false);
    },
    [onSelect],
  );

  // Handle keyboard navigation, returns true if event was handled
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!showAutocomplete) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0,
        );
        return true;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1,
        );
        return true;
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          handleSelect(filteredCommands[selectedIndex]);
        }
        return true;
      } else if (e.key === "Escape") {
        e.preventDefault();
        setShowAutocomplete(false);
        return true;
      }

      return false;
    },
    [showAutocomplete, filteredCommands, selectedIndex, handleSelect],
  );

  return {
    showAutocomplete,
    filteredCommands,
    selectedIndex,
    setSelectedIndex,
    handleSelect,
    handleKeyDown,
    close,
  };
}
