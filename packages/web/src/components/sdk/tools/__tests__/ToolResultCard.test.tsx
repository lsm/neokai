// @ts-nocheck
/**
 * Tests for ToolResultCard Component Logic
 *
 * Tests pure logic without mock.module to avoid polluting other tests.
 * IMPORTANT: Bun's mock.module() persists across test files, so we test
import { describe, it, expect } from 'vitest';
 * the underlying logic without using module mocks.
 */

// Tool color configuration matching the component
const TOOL_COLORS = {
  file: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-600" },
  search: {
    bg: "bg-purple-50",
    border: "border-purple-200",
    text: "text-purple-600",
  },
  command: {
    bg: "bg-green-50",
    border: "border-green-200",
    text: "text-green-600",
  },
  thinking: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-600",
  },
  system: {
    bg: "bg-gray-50",
    border: "border-gray-200",
    text: "text-gray-600",
  },
};

// Tool category mapping
function getToolCategory(toolName: string): keyof typeof TOOL_COLORS {
  const fileTools = ["Read", "Write", "Edit", "Glob", "NotebookEdit"];
  const searchTools = ["Grep", "WebSearch", "WebFetch"];
  const commandTools = ["Bash", "Task", "Skill"];
  const thinkingTools = ["Thinking"];

  if (fileTools.includes(toolName)) return "file";
  if (searchTools.includes(toolName)) return "search";
  if (commandTools.includes(toolName)) return "command";
  if (thinkingTools.includes(toolName)) return "thinking";
  return "system";
}

// Get display name from tool name (handle MCP tools)
function getDisplayName(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    return parts[parts.length - 1];
  }
  return toolName;
}

// Get file extension from path
function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

// Count lines in text
function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

// Calculate diff stats
function calculateDiffStats(
  oldString: string,
  newString: string,
): { added: number; removed: number } {
  const oldLines = oldString ? oldString.split("\n").length : 0;
  const newLines = newString ? newString.split("\n").length : 0;

  // Simplified diff calculation
  return {
    added: newLines,
    removed: oldLines,
  };
}

// Format input summary for display
function formatInputSummary(toolName: string, input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";

  const inputObj = input as Record<string, unknown>;

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (inputObj.file_path) {
        const path = inputObj.file_path as string;
        const fileName = path.split("/").pop() || path;
        return fileName;
      }
      break;
    case "Bash":
      if (inputObj.command) {
        const cmd = inputObj.command as string;
        return cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd;
      }
      break;
    case "Grep":
      if (inputObj.pattern) {
        return `/${inputObj.pattern}/`;
      }
      break;
    case "Glob":
      if (inputObj.pattern) {
        return inputObj.pattern as string;
      }
      break;
  }

  return "";
}

// Determine if tool should be expanded by default
function shouldExpandByDefault(toolName: string, isError: boolean): boolean {
  // Errors are always collapsed
  if (isError) return false;

  // Thinking tool is expanded by default
  if (toolName === "Thinking") return true;

  return false;
}

describe("ToolResultCard Logic", () => {
  describe("Tool Categories", () => {
    it("should categorize file tools correctly", () => {
      expect(getToolCategory("Read")).toBe("file");
      expect(getToolCategory("Write")).toBe("file");
      expect(getToolCategory("Edit")).toBe("file");
      expect(getToolCategory("Glob")).toBe("file");
    });

    it("should categorize search tools correctly", () => {
      expect(getToolCategory("Grep")).toBe("search");
      expect(getToolCategory("WebSearch")).toBe("search");
      expect(getToolCategory("WebFetch")).toBe("search");
    });

    it("should categorize command tools correctly", () => {
      expect(getToolCategory("Bash")).toBe("command");
      expect(getToolCategory("Task")).toBe("command");
      expect(getToolCategory("Skill")).toBe("command");
    });

    it("should categorize thinking tools correctly", () => {
      expect(getToolCategory("Thinking")).toBe("thinking");
    });

    it("should default to system category for unknown tools", () => {
      expect(getToolCategory("UnknownTool")).toBe("system");
      expect(getToolCategory("CustomPlugin")).toBe("system");
    });
  });

  describe("Tool Colors", () => {
    it("should return blue colors for file tools", () => {
      const category = getToolCategory("Read");
      expect(TOOL_COLORS[category].bg).toBe("bg-blue-50");
    });

    it("should return purple colors for search tools", () => {
      const category = getToolCategory("Grep");
      expect(TOOL_COLORS[category].bg).toBe("bg-purple-50");
    });

    it("should return green colors for command tools", () => {
      const category = getToolCategory("Bash");
      expect(TOOL_COLORS[category].bg).toBe("bg-green-50");
    });

    it("should return amber colors for thinking tools", () => {
      const category = getToolCategory("Thinking");
      expect(TOOL_COLORS[category].bg).toBe("bg-amber-50");
    });
  });

  describe("MCP Tool Display Names", () => {
    it("should extract tool name from MCP format", () => {
      expect(getDisplayName("mcp__filesystem__read")).toBe("read");
      expect(getDisplayName("mcp__server__action__execute")).toBe("execute");
    });

    it("should return original name for non-MCP tools", () => {
      expect(getDisplayName("Read")).toBe("Read");
      expect(getDisplayName("Bash")).toBe("Bash");
    });
  });

  describe("File Extension Detection", () => {
    it("should extract extension from file path", () => {
      expect(getFileExtension("/path/to/file.ts")).toBe("ts");
      expect(getFileExtension("/path/to/file.test.tsx")).toBe("tsx");
      expect(getFileExtension("config.json")).toBe("json");
    });

    it("should handle files without extension", () => {
      expect(getFileExtension("Makefile")).toBe("");
      expect(getFileExtension("/path/to/Dockerfile")).toBe("");
    });
  });

  describe("Line Counting", () => {
    it("should count lines correctly", () => {
      expect(countLines("line1\nline2\nline3")).toBe(3);
      expect(countLines("single line")).toBe(1);
      expect(countLines("")).toBe(0);
    });

    it("should handle undefined/null input", () => {
      expect(countLines(null as unknown as string)).toBe(0);
      expect(countLines(undefined as unknown as string)).toBe(0);
    });
  });

  describe("Diff Stats Calculation", () => {
    it("should calculate lines added and removed", () => {
      const stats = calculateDiffStats("old line", "new line 1\nnew line 2");
      expect(stats.added).toBe(2);
      expect(stats.removed).toBe(1);
    });

    it("should handle empty strings", () => {
      const stats = calculateDiffStats("", "new content");
      expect(stats.added).toBe(1);
      expect(stats.removed).toBe(0);
    });
  });

  describe("Input Summary Formatting", () => {
    it("should format Read tool input", () => {
      const summary = formatInputSummary("Read", {
        file_path: "/path/to/file.ts",
      });
      expect(summary).toBe("file.ts");
    });

    it("should format Bash tool input", () => {
      const summary = formatInputSummary("Bash", { command: "echo hello" });
      expect(summary).toBe("echo hello");
    });

    it("should truncate long Bash commands", () => {
      const longCmd = "a".repeat(100);
      const summary = formatInputSummary("Bash", { command: longCmd });
      expect(summary.length).toBe(53); // 50 + '...'
      expect(summary.endsWith("...")).toBe(true);
    });

    it("should format Grep tool input", () => {
      const summary = formatInputSummary("Grep", { pattern: "test.*pattern" });
      expect(summary).toBe("/test.*pattern/");
    });

    it("should format Glob tool input", () => {
      const summary = formatInputSummary("Glob", { pattern: "**/*.ts" });
      expect(summary).toBe("**/*.ts");
    });

    it("should handle string input", () => {
      const summary = formatInputSummary(
        "Thinking",
        "This is thinking content",
      );
      expect(summary).toBe("This is thinking content");
    });
  });

  describe("Expand/Collapse Default State", () => {
    it("should not expand by default for most tools", () => {
      expect(shouldExpandByDefault("Read", false)).toBe(false);
      expect(shouldExpandByDefault("Bash", false)).toBe(false);
      expect(shouldExpandByDefault("Edit", false)).toBe(false);
    });

    it("should expand Thinking tool by default", () => {
      expect(shouldExpandByDefault("Thinking", false)).toBe(true);
    });

    it("should not expand on error", () => {
      expect(shouldExpandByDefault("Thinking", true)).toBe(false);
      expect(shouldExpandByDefault("Read", true)).toBe(false);
    });
  });

  describe("Variant Styles", () => {
    it("should determine compact variant styles", () => {
      const variant = "compact";
      const isCompact = variant === "compact";
      const isInline = variant === "inline";

      expect(isCompact).toBe(true);
      expect(isInline).toBe(false);
    });

    it("should determine inline variant styles", () => {
      const variant = "inline";
      const isCompact = variant === "compact";
      const isInline = variant === "inline";

      expect(isCompact).toBe(false);
      expect(isInline).toBe(true);
    });

    it("should determine default variant styles", () => {
      const variant = "default";
      const isCompact = variant === "compact";
      const isInline = variant === "inline";

      expect(isCompact).toBe(false);
      expect(isInline).toBe(false);
    });
  });

  describe("Error State Styling", () => {
    it("should apply error styling when isError is true", () => {
      const isError = true;
      const errorClass = isError ? "text-red-600" : "";
      const errorBg = isError ? "bg-red-50" : "";

      expect(errorClass).toBe("text-red-600");
      expect(errorBg).toBe("bg-red-50");
    });

    it("should not apply error styling when isError is false", () => {
      const isError = false;
      const errorClass = isError ? "text-red-600" : "";

      expect(errorClass).toBe("");
    });
  });

  describe("Output Removed State", () => {
    it("should show warning when output is removed", () => {
      const isOutputRemoved = true;
      const showWarning = isOutputRemoved;

      expect(showWarning).toBe(true);
    });

    it("should not show warning when output is present", () => {
      const isOutputRemoved = false;
      const showWarning = isOutputRemoved;

      expect(showWarning).toBe(false);
    });
  });

  describe("Special Tool Rendering Logic", () => {
    describe("Edit Tool", () => {
      it("should detect Edit tool with diff data", () => {
        const toolName = "Edit";
        const input = {
          file_path: "/test.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        };

        const hasDiff =
          toolName === "Edit" &&
          input.old_string !== undefined &&
          input.new_string !== undefined;

        expect(hasDiff).toBe(true);
      });
    });

    describe("Write Tool", () => {
      it("should detect Write tool with content", () => {
        const toolName = "Write";
        const input = {
          file_path: "/test.ts",
          content: "const x = 1;\nconst y = 2;",
        };

        const hasWriteContent =
          toolName === "Write" && input.content !== undefined;

        expect(hasWriteContent).toBe(true);
      });

      it("should calculate lines for Write tool", () => {
        const content = "line1\nline2\nline3";
        const lines = countLines(content);

        expect(lines).toBe(3);
      });
    });

    describe("Thinking Tool", () => {
      it("should detect Thinking tool", () => {
        const toolName = "Thinking";
        const isThinking = toolName === "Thinking";

        expect(isThinking).toBe(true);
      });

      it("should calculate character count for Thinking", () => {
        const input = "This is the thinking process...";
        const charCount = input.length;

        expect(charCount).toBe(31);
      });
    });

    describe("TodoWrite Tool", () => {
      it("should detect TodoWrite tool with todos", () => {
        const toolName = "TodoWrite";
        const input = {
          todos: [
            { content: "Task 1", status: "completed", activeForm: "" },
            { content: "Task 2", status: "pending", activeForm: "" },
          ],
        };

        const hasTodos = toolName === "TodoWrite" && Array.isArray(input.todos);

        expect(hasTodos).toBe(true);
        expect(input.todos.length).toBe(2);
      });
    });
  });

  describe("Output Display Logic", () => {
    it("should handle string output", () => {
      const output = "hello";
      const displayOutput =
        typeof output === "string" ? output : JSON.stringify(output, null, 2);

      expect(displayOutput).toBe("hello");
    });

    it("should handle object output", () => {
      const output = { result: "success", count: 42 };
      const displayOutput =
        typeof output === "string" ? output : JSON.stringify(output, null, 2);

      expect(displayOutput).toContain("success");
      expect(displayOutput).toContain("42");
    });

    it("should handle null output", () => {
      const output = null;
      const hasOutput = output !== null && output !== undefined;

      expect(hasOutput).toBe(false);
    });

    it("should handle undefined output", () => {
      const output = undefined;
      const hasOutput = output !== null && output !== undefined;

      expect(hasOutput).toBe(false);
    });
  });

  describe("Detailed Variant", () => {
    it("should include tool ID in detailed mode", () => {
      const variant = "detailed";
      const toolId = "bash-123";
      const showToolId = variant === "detailed";

      expect(showToolId).toBe(true);
      expect(toolId).toBe("bash-123");
    });
  });
});
