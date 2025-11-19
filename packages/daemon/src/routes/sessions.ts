import type { Elysia } from "elysia";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateSessionRequest,
} from "@liuboer/shared";
import type { SessionManager } from "../lib/session-manager";
import { query } from "@anthropic-ai/claude-agent-sdk";

export function createSessionsRouter(app: Elysia, sessionManager: SessionManager) {
  return app
    // Create session
    .post("/api/sessions", async ({ body, set }) => {
      const { workspacePath, initialTools, config } = body as CreateSessionRequest;

      const sessionId = await sessionManager.createSession({
        workspacePath,
        initialTools,
        config,
      });

      set.status = 201;
      const response: CreateSessionResponse = { sessionId };
      return response;
    })

    // List sessions
    .get("/api/sessions", () => {
      const sessions = sessionManager.listSessions();
      const response: ListSessionsResponse = { sessions };
      return response;
    })

    // Get session
    .get("/api/sessions/:sessionId", ({ params, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      const session = agentSession.getSessionData();
      const messages = agentSession.getMessages();

      const response: GetSessionResponse = {
        session,
        messages,
        activeTools: [], // TODO: Implement
        context: {
          files: [],
          workingDirectory: session.workspacePath,
        },
      };

      return response;
    })

    // Update session
    .patch("/api/sessions/:sessionId", async ({ params, body, set }) => {
      const sessionId = params.sessionId;
      const updates = body as UpdateSessionRequest;

      const agentSession = sessionManager.getSession(sessionId);
      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      await sessionManager.updateSession(sessionId, updates);
      set.status = 204;
    })

    // Delete session
    .delete("/api/sessions/:sessionId", async ({ params, set }) => {
      const sessionId = params.sessionId;
      await sessionManager.deleteSession(sessionId);
      set.status = 204;
    })

    // Send message
    .post("/api/sessions/:sessionId/messages", async ({ params, body, set }) => {
      const sessionId = params.sessionId;
      const { content } = body as SendMessageRequest;

      const agentSession = sessionManager.getSession(sessionId);
      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      try {
        const messageId = await agentSession.sendMessage(content);

        set.status = 201;
        const response: SendMessageResponse = {
          messageId,
          status: "processing",
        };

        return response;
      } catch (error) {
        // Handle API/auth errors gracefully
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it's an auth error
        if (errorMessage.includes("authentication") || errorMessage.includes("API key") ||
            errorMessage.includes("OAuth") || errorMessage.includes("exited with code 1")) {
          set.status = 401;
          return {
            error: "Authentication required",
            message: "No valid authentication configured. Please set up OAuth or API key."
          };
        }

        // Other errors
        set.status = 500;
        return {
          error: "Failed to send message",
          message: errorMessage
        };
      }
    })

    // Get messages
    .get("/api/sessions/:sessionId/messages", ({ params, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      const messages = agentSession.getMessages();
      return { messages };
    })

    // Clear messages
    .delete("/api/sessions/:sessionId/messages", async ({ params, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      await sessionManager.clearMessages(sessionId);
      set.status = 204;
    })

    // Get SDK messages
    .get("/api/sessions/:sessionId/sdk-messages", ({ params, query, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      const limit = query.limit ? parseInt(query.limit as string, 10) : 100;
      const offset = query.offset ? parseInt(query.offset as string, 10) : 0;

      const sdkMessages = agentSession.getSDKMessages(limit, offset);
      return { sdkMessages };
    })

    // Simple test endpoint that replicates the exact test behavior
    .get("/api/test/simple-query", async ({ set }) => {
      console.log("\n[TEST ENDPOINT] Starting simple query test");
      console.log("[TEST ENDPOINT] OAuth token:", process.env.CLAUDE_CODE_OAUTH_TOKEN ? "SET" : "NOT SET");
      console.log("[TEST ENDPOINT] API key:", process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET");

      try {
        const prompt = "What is 2+2? Answer with just the number.";

        console.log("[TEST ENDPOINT] Creating query stream...");
        const queryStream = query({
          prompt,
          options: {
            model: "claude-sonnet-4-5-20250929",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
          },
        });

        console.log("[TEST ENDPOINT] Processing messages...");
        let assistantResponse = "";
        let messageCount = 0;

        for await (const message of queryStream) {
          messageCount++;
          console.log(`[TEST ENDPOINT] Received message #${messageCount}, type: ${message.type}`);

          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text") {
                assistantResponse += block.text;
                console.log("[TEST ENDPOINT] Got text:", block.text);
              }
            }
          } else if (message.type === "result") {
            console.log("[TEST ENDPOINT] Got result:", {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
            });
          }
        }

        console.log("[TEST ENDPOINT] Complete! Response:", assistantResponse);

        return {
          success: true,
          response: assistantResponse,
          messageCount,
        };
      } catch (error) {
        console.error("[TEST ENDPOINT] Error:", error);
        set.status = 500;
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // Test with cwd option (like daemon sendMessage does)
    .get("/api/test/with-cwd", async ({ set }) => {
      console.log("\n[TEST WITH CWD] Starting test");
      console.log("[TEST WITH CWD] cwd:", process.env.WORKSPACE_ROOT || "/tmp/workspace");

      try {
        const prompt = "What is 2+2? Answer with just the number.";

        console.log("[TEST WITH CWD] Creating query stream with cwd...");
        const queryStream = query({
          prompt,
          options: {
            model: "claude-sonnet-4-5-20250929",
            cwd: process.env.WORKSPACE_ROOT || "/tmp/workspace",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
          },
        });

        console.log("[TEST WITH CWD] Processing messages...");
        let assistantResponse = "";
        let messageCount = 0;
        let timeout = false;

        // Add timeout to detect hanging
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            timeout = true;
            reject(new Error("Stream timeout after 5 seconds"));
          }, 5000);
        });

        try {
          await Promise.race([
            (async () => {
              for await (const message of queryStream) {
                messageCount++;
                console.log(`[TEST WITH CWD] Received message #${messageCount}, type: ${message.type}`);

                if (message.type === "assistant") {
                  for (const block of message.message.content) {
                    if (block.type === "text") {
                      assistantResponse += block.text;
                    }
                  }
                } else if (message.type === "result") {
                  console.log("[TEST WITH CWD] Got result");
                }
              }
            })(),
            timeoutPromise,
          ]);
        } catch (err) {
          if (timeout) {
            console.error("[TEST WITH CWD] Stream timed out - SDK not yielding messages!");
            throw new Error("SDK stream timeout - likely bad cwd path");
          }
          throw err;
        }

        console.log("[TEST WITH CWD] Complete! Response:", assistantResponse);

        return {
          success: true,
          response: assistantResponse,
          messageCount,
        };
      } catch (error) {
        console.error("[TEST WITH CWD] Error:", error);
        set.status = 500;
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}
