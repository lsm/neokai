import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { MessageHubAPIClient } from "../src/lib/messagehub-api-client";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  SendMessageResponse,
} from "@liuboer/shared";

describe("MessageHubAPIClient", () => {
  let client: MessageHubAPIClient;
  let mockMessageHub: any;
  let mockTransport: any;

  beforeEach(() => {
    // Create mock transport
    mockTransport = {
      connect: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
      close: mock(() => {}), // WebSocket transport uses close()
      send: mock(() => Promise.resolve()),
      onMessage: mock(() => {}),
      onConnectionChange: mock(() => {}),
      getState: mock(() => "connected"),
      isReady: mock(() => true),
      name: "mock-transport",
    };

    // Create mock MessageHub
    mockMessageHub = {
      call: mock((method: string, data: any, options?: any) => {
        // Simulate successful responses based on method
        if (method === "session.create") {
          return Promise.resolve({ sessionId: "test-session-id" });
        }
        if (method === "session.list") {
          return Promise.resolve({
            sessions: [
              { id: "session1", name: "Test Session 1" },
              { id: "session2", name: "Test Session 2" },
            ],
          });
        }
        if (method === "message.send") {
          return Promise.resolve({ success: true });
        }
        if (method === "session.delete") {
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({});
      }),
      subscribe: mock((pattern: string, handler: any) => {
        // Return unsubscribe function
        return () => {};
      }),
      registerTransport: mock(() => {}),
    };

    client = new MessageHubAPIClient("http://localhost:8283");

    // Inject mocks directly
    (client as any).messageHub = mockMessageHub;
    (client as any).transport = mockTransport;
  });

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
  });

  describe("Connection Management", () => {
    test("should establish connection on first API call", async () => {
      const freshClient = new MessageHubAPIClient("http://localhost:8283");

      // Mock the private connect method
      (freshClient as any).connect = mock(async () => {
        (freshClient as any).messageHub = mockMessageHub;
        (freshClient as any).transport = mockTransport;
      });

      await freshClient.createSession({ workspacePath: "/test" });

      expect((freshClient as any).connect).toHaveBeenCalled();
    });

    test("should reuse existing connection", async () => {
      await client.createSession({ workspacePath: "/test" });
      await client.listSessions();

      // Should only call through messageHub, not create new connection
      expect(mockMessageHub.call).toHaveBeenCalledTimes(2);
    });

    test("should disconnect properly", () => {
      client.disconnect();

      expect(mockTransport.close).toHaveBeenCalled();
      expect((client as any).messageHub).toBeNull();
      expect((client as any).transport).toBeNull();
    });

    test("should handle connection errors gracefully", async () => {
      const errorClient = new MessageHubAPIClient("http://localhost:8283");

      (errorClient as any).connect = mock(async () => {
        throw new Error("Connection failed");
      });

      await expect(
        errorClient.createSession({ workspacePath: "/test" })
      ).rejects.toThrow("Connection failed");
    });
  });

  describe("Session Management", () => {
    test("should create session successfully", async () => {
      const request: CreateSessionRequest = {
        workspacePath: "/test/workspace",
      };

      const response = await client.createSession(request);

      expect(response.sessionId).toBe("test-session-id");
      expect(mockMessageHub.call).toHaveBeenCalledWith(
        "session.create",
        request,
        { timeout: 15000 }
      );
    });

    test("should list sessions", async () => {
      const response = await client.listSessions();

      expect(response.sessions).toHaveLength(2);
      expect(response.sessions[0].id).toBe("session1");
      expect(mockMessageHub.call).toHaveBeenCalledWith("session.list", {});
    });

    test("should delete session", async () => {
      const response = await client.deleteSession("test-session-id");

      expect(response.success).toBe(true);
      expect(mockMessageHub.call).toHaveBeenCalledWith("session.delete", {
        sessionId: "test-session-id",
      });
    });

    test("should get session info", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "session.info") {
          return Promise.resolve({
            id: "test-session-id",
            name: "Test Session",
            createdAt: Date.now(),
          });
        }
      });

      const response = await client.getSessionInfo("test-session-id");

      expect(response.id).toBe("test-session-id");
      expect(mockMessageHub.call).toHaveBeenCalledWith("session.info", {
        sessionId: "test-session-id",
      });
    });
  });

  describe("Message Operations", () => {
    test("should send message successfully", async () => {
      const request: SendMessageRequest = {
        sessionId: "test-session-id",
        content: "Hello, world!",
      };

      const response = await client.sendMessage(request);

      expect(response.success).toBe(true);
      expect(mockMessageHub.call).toHaveBeenCalledWith("message.send", request);
    });

    test("should get message history", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "message.history") {
          return Promise.resolve({
            messages: [
              { id: "msg1", content: "Message 1" },
              { id: "msg2", content: "Message 2" },
            ],
          });
        }
      });

      const response = await client.getMessageHistory("test-session-id");

      expect(response.messages).toHaveLength(2);
      expect(mockMessageHub.call).toHaveBeenCalledWith("message.history", {
        sessionId: "test-session-id",
      });
    });
  });

  describe("Command Operations", () => {
    test("should execute command", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "command.execute") {
          return Promise.resolve({ result: "Command executed" });
        }
      });

      const response = await client.executeCommand(
        "test-session-id",
        "test-command"
      );

      expect(response.result).toBe("Command executed");
      expect(mockMessageHub.call).toHaveBeenCalledWith("command.execute", {
        sessionId: "test-session-id",
        command: "test-command",
      });
    });

    test("should list available commands", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "command.list") {
          return Promise.resolve({
            commands: ["cmd1", "cmd2", "cmd3"],
          });
        }
      });

      const response = await client.listCommands("test-session-id");

      expect(response.commands).toHaveLength(3);
      expect(mockMessageHub.call).toHaveBeenCalledWith("command.list", {
        sessionId: "test-session-id",
      });
    });
  });

  describe("File Operations", () => {
    test("should read file", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "file.read") {
          return Promise.resolve({
            content: "File content",
            path: "/test/file.txt",
          });
        }
      });

      const response = await client.readFile("test-session-id", "/test/file.txt");

      expect(response.content).toBe("File content");
      expect(mockMessageHub.call).toHaveBeenCalledWith("file.read", {
        sessionId: "test-session-id",
        path: "/test/file.txt",
      });
    });

    test("should write file", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "file.write") {
          return Promise.resolve({ success: true });
        }
      });

      const response = await client.writeFile(
        "test-session-id",
        "/test/file.txt",
        "New content"
      );

      expect(response.success).toBe(true);
      expect(mockMessageHub.call).toHaveBeenCalledWith("file.write", {
        sessionId: "test-session-id",
        path: "/test/file.txt",
        content: "New content",
      });
    });
  });

  describe("System Operations", () => {
    test("should get system info", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "system.info") {
          return Promise.resolve({
            version: "1.0.0",
            uptime: 12345,
          });
        }
      });

      const response = await client.getSystemInfo();

      expect(response.version).toBe("1.0.0");
      expect(mockMessageHub.call).toHaveBeenCalledWith("system.info", {});
    });

    test("should get health status", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "system.health") {
          return Promise.resolve({
            status: "healthy",
            checks: { database: true, auth: true },
          });
        }
      });

      const response = await client.getHealth();

      expect(response.status).toBe("healthy");
      expect(mockMessageHub.call).toHaveBeenCalledWith("system.health", {});
    });
  });

  describe("Authentication Operations", () => {
    test("should get auth status", async () => {
      mockMessageHub.call = mock((method: string) => {
        if (method === "auth.status") {
          return Promise.resolve({
            isAuthenticated: true,
            method: "api_key",
          });
        }
      });

      const response = await client.getAuthStatus();

      expect(response.isAuthenticated).toBe(true);
      expect(mockMessageHub.call).toHaveBeenCalledWith("auth.status", {});
    });
  });

  describe("Subscription Management", () => {
    test("should subscribe to events", () => {
      const handler = mock((data: any) => {});

      const unsubscribe = client.subscribe("message.created", handler);

      expect(mockMessageHub.subscribe).toHaveBeenCalledWith(
        "message.created",
        handler
      );
      expect(typeof unsubscribe).toBe("function");
    });

    test("should unsubscribe from events", () => {
      const handler = mock((data: any) => {});
      const mockUnsubscribe = mock(() => {});

      mockMessageHub.subscribe = mock(() => mockUnsubscribe);

      const unsubscribe = client.subscribe("message.created", handler);
      unsubscribe();

      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    test("should throw error when subscribing without connection", () => {
      const disconnectedClient = new MessageHubAPIClient("http://localhost:8283");
      const handler = mock((data: any) => {});

      expect(() => {
        disconnectedClient.subscribe("message.created", handler);
      }).toThrow("MessageHub not connected");
    });
  });

  describe("Error Handling", () => {
    test("should handle RPC call errors", async () => {
      mockMessageHub.call = mock(() => {
        return Promise.reject(new Error("RPC call failed"));
      });

      await expect(
        client.createSession({ workspacePath: "/test" })
      ).rejects.toThrow("RPC call failed");
    });

    test("should handle timeout errors", async () => {
      mockMessageHub.call = mock(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timeout")), 100);
        });
      });

      await expect(
        client.createSession({ workspacePath: "/test" })
      ).rejects.toThrow("Timeout");
    });

    test("should handle transport disconnection", async () => {
      mockTransport.getState = mock(() => "disconnected");
      mockTransport.isReady = mock(() => false);

      mockMessageHub.call = mock(() => {
        return Promise.reject(new Error("Not connected to transport"));
      });

      await expect(
        client.createSession({ workspacePath: "/test" })
      ).rejects.toThrow("Not connected to transport");
    });
  });
});
