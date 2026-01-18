// @ts-nocheck
/**
 * SDKMessageRenderer Component Tests
 *
 * Tests SDK message routing and rendering logic
 */
import { describe, it, expect } from "vitest";

import { render } from "@testing-library/preact";
import { SDKMessageRenderer } from "../SDKMessageRenderer";
import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import type { UUID } from "crypto";

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Mock message factories
function createUserMessage(content: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: "test-session",
  };
}

function createAssistantMessage(textContent: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: textContent }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: "test-session",
  } as unknown as SDKMessage;
}

function createResultMessage(success: boolean): SDKMessage {
  const base = {
    type: "result" as const,
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: !success,
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: createUUID(),
    session_id: "test-session",
  };

  if (success) {
    return {
      ...base,
      subtype: "success",
      result: "Operation completed",
    } as unknown as SDKMessage;
  }
  return {
    ...base,
    subtype: "error_during_execution",
    errors: ["Something went wrong"],
  } as unknown as SDKMessage;
}

function createSystemInitMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    agents: [],
    apiKeySource: "user",
    betas: [],
    claude_code_version: "1.0.0",
    cwd: "/test/path",
    tools: ["Read", "Write", "Bash"],
    mcp_servers: [],
    model: "claude-3-5-sonnet-20241022",
    permissionMode: "default",
    slash_commands: ["help", "clear"],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: createUUID(),
    session_id: "test-session",
  };
}

function createToolProgressMessage(): SDKMessage {
  return {
    type: "tool_progress",
    tool_use_id: "toolu_test123",
    tool_name: "Read",
    parent_tool_use_id: null,
    elapsed_time_seconds: 2.5,
    uuid: createUUID(),
    session_id: "test-session",
  };
}

function createStreamEventMessage(): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: "test-session",
  } as unknown as SDKMessage;
}

function createAuthStatusMessage(): SDKMessage {
  return {
    type: "auth_status",
    isAuthenticating: true,
    output: ["Authenticating..."],
    uuid: createUUID(),
    session_id: "test-session",
  };
}

function createSubagentMessage(): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_subagent",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Subagent response" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: "toolu_parent123", // This marks it as a subagent message
    uuid: createUUID(),
    session_id: "test-session",
  } as unknown as SDKMessage;
}

function createUserReplayMessage(): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: "<local-command-stdout>Command output</local-command-stdout>",
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: "test-session",
    isReplay: true,
  };
}

describe("SDKMessageRenderer", () => {
  describe("Message Type Routing", () => {
    it("should render user message", () => {
      const message = createUserMessage("Hello world");
      const { container } = render(<SDKMessageRenderer message={message} />);

      const userMessage = container.querySelector(
        '[data-testid="user-message"]',
      );
      expect(userMessage).toBeTruthy();
    });

    it("should render assistant message", () => {
      const message = createAssistantMessage("Hi there!");
      const { container } = render(<SDKMessageRenderer message={message} />);

      const assistantMessage = container.querySelector(
        '[data-testid="assistant-message"]',
      );
      expect(assistantMessage).toBeTruthy();
    });

    it("should render result message", () => {
      const message = createResultMessage(true);
      const { container } = render(<SDKMessageRenderer message={message} />);

      // Result messages have a button for expanding details
      const resultMessage = container.querySelector("button");
      expect(resultMessage).toBeTruthy();
      expect(container.textContent).toContain("tokens");
    });

    it("should render tool progress message", () => {
      const message = createToolProgressMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // ToolProgressCard shows tool name
      expect(container.textContent).toContain("Read");
    });

    it("should render auth status message", () => {
      const message = createAuthStatusMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // AuthStatusCard should be rendered
      expect(container.textContent).toContain("Authenticating");
    });

    it("should render user replay message (slash command response)", () => {
      const message = createUserReplayMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // SlashCommandOutput should handle this
      expect(container.textContent).toContain("Command output");
    });
  });

  describe("Filtering Logic", () => {
    it("should skip stream events (not user visible)", () => {
      const message = createStreamEventMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // Should return null for stream events
      expect(container.innerHTML).toBe("");
    });

    it("should skip system init messages (shown as indicators)", () => {
      const message = createSystemInitMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // System init messages are skipped - shown as SessionIndicator instead
      expect(container.innerHTML).toBe("");
    });

    it("should skip subagent messages (shown inside SubagentBlock)", () => {
      const message = createSubagentMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      // Subagent messages should be filtered out
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Props Passing", () => {
    it("should pass toolResultsMap to assistant message", () => {
      const message = createAssistantMessage("Testing with tools");
      const toolResultsMap = new Map([
        ["toolu_test", { content: "Tool result" }],
      ]);

      const { container } = render(
        <SDKMessageRenderer
          message={message}
          toolResultsMap={toolResultsMap}
        />,
      );

      expect(
        container.querySelector('[data-testid="assistant-message"]'),
      ).toBeTruthy();
    });

    it("should pass sessionInfo to user message", () => {
      const message = createUserMessage("Hello");
      const sessionInfo = createSystemInitMessage() as Extract<
        SDKMessage,
        { type: "system"; subtype: "init" }
      >;

      const { container } = render(
        <SDKMessageRenderer message={message} sessionInfo={sessionInfo} />,
      );

      // User message should be rendered with session info available
      expect(
        container.querySelector('[data-testid="user-message"]'),
      ).toBeTruthy();
    });

    it("should pass toolInput to tool progress message", () => {
      const message = createToolProgressMessage();
      const toolInputsMap = new Map([
        ["toolu_test123", { file_path: "/test/file.txt" }],
      ]);

      const { container } = render(
        <SDKMessageRenderer message={message} toolInputsMap={toolInputsMap} />,
      );

      // ToolProgressCard should receive the input
      expect(container.textContent).toContain("Read");
    });
  });

  describe("Unknown Message Types", () => {
    it("should render fallback for unknown message types", () => {
      const unknownMessage = {
        type: "unknown_type",
        uuid: createUUID(),
        session_id: "test-session",
      } as unknown as SDKMessage;

      const { container } = render(
        <SDKMessageRenderer message={unknownMessage} />,
      );

      // Should show unknown type fallback
      expect(container.textContent).toContain("Unknown message type");
    });
  });

  describe("Error Message Handling", () => {
    it("should render error result message", () => {
      const message = createResultMessage(false);
      const { container } = render(<SDKMessageRenderer message={message} />);

      // Error result should be rendered with error styling
      expect(
        container.querySelector(".bg-red-50, .bg-red-900\\/10"),
      ).toBeTruthy();
    });
  });
});
