/**
 * Files API Integration Tests
 *
 * Tests file system operation endpoints:
 * - GET /api/sessions/:sessionId/files (read file)
 * - GET /api/sessions/:sessionId/files/list (list directory)
 * - GET /api/sessions/:sessionId/files/tree (get file tree)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import type { CreateSessionResponse } from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  assertErrorResponse,
  assertEquals,
  assertExists,
  assertTrue,
  type TestContext,
} from "./test-utils";

// Test workspace directory
const TEST_WORKSPACE = join(import.meta.dir, ".test-workspace");

async function setupTestWorkspace() {
  // Create test workspace
  await mkdir(TEST_WORKSPACE, { recursive: true });

  // Create test files
  await writeFile(join(TEST_WORKSPACE, "test.txt"), "Hello, World!");
  await writeFile(join(TEST_WORKSPACE, "package.json"), '{"name": "test"}');

  // Create subdirectory with files
  await mkdir(join(TEST_WORKSPACE, "src"), { recursive: true });
  await writeFile(join(TEST_WORKSPACE, "src", "index.ts"), "console.log('test');");
  await writeFile(join(TEST_WORKSPACE, "src", "utils.ts"), "export const util = () => {};");

  // Create nested directory
  await mkdir(join(TEST_WORKSPACE, "src", "lib"), { recursive: true });
  await writeFile(
    join(TEST_WORKSPACE, "src", "lib", "helper.ts"),
    "export const helper = () => {};",
  );
}

async function cleanupTestWorkspace() {
  try {
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
  } catch (error) {
    // Ignore errors during cleanup
  }
}

describe("Files API", () => {
  beforeAll(async () => {
    await setupTestWorkspace();
  });

  afterAll(async () => {
    await cleanupTestWorkspace();
  });

  describe("GET /api/sessions/:sessionId/files", () => {
    test("should read file content", async () => {
      const ctx = await createTestApp();
      try {
        // Create session with test workspace
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Read file
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=test.txt`,
        );
        const result = await response.json();

        assertExists(result.content);
        assertEquals(result.content, "Hello, World!");
        assertEquals(result.path, "test.txt");
        assertEquals(result.encoding, "utf-8");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should read JSON file", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=package.json`,
        );
        const result = await response.json();

        assertExists(result.content);
        assertEquals(result.content, '{"name": "test"}');
      } finally {
        await ctx.cleanup();
      }
    });

    test("should read file from subdirectory", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=src/index.ts`,
        );
        const result = await response.json();

        assertExists(result.content);
        assertEquals(result.content, "console.log('test');");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should support base64 encoding", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=test.txt&encoding=base64`,
        );
        const result = await response.json();

        assertExists(result.content);
        assertEquals(result.encoding, "base64");
        // Base64 encoded "Hello, World!"
        const decoded = Buffer.from(result.content, "base64").toString("utf-8");
        assertEquals(decoded, "Hello, World!");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail without path parameter", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files`,
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "path query parameter is required");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent file", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=nonexistent.txt`,
        );

        assertEquals(response.status, 500);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${fakeId}/files?path=test.txt`,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, `Session ${fakeId} not found`);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/sessions/:sessionId/files/list", () => {
    test("should list root directory files", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/list`,
        );
        const result = await response.json();

        assertExists(result.files);
        assertTrue(Array.isArray(result.files));
        assertTrue(result.files.length > 0);

        // Check for expected files
        const fileNames = result.files.map((f: any) => f.name);
        assertTrue(fileNames.includes("test.txt"));
        assertTrue(fileNames.includes("package.json"));
        assertTrue(fileNames.includes("src"));
      } finally {
        await ctx.cleanup();
      }
    });

    test("should list subdirectory files", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/list?path=src`,
        );
        const result = await response.json();

        assertExists(result.files);
        const fileNames = result.files.map((f: any) => f.name);
        assertTrue(fileNames.includes("index.ts"));
        assertTrue(fileNames.includes("utils.ts"));
        assertTrue(fileNames.includes("lib"));
      } finally {
        await ctx.cleanup();
      }
    });

    test("should support recursive listing", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/list?path=src&recursive=true`,
        );
        const result = await response.json();

        assertExists(result.files);
        const paths = result.files.map((f: any) => f.path);

        // Should include files from nested directories
        assertTrue(paths.some((p: string) => p.includes("lib/helper.ts")));
      } finally {
        await ctx.cleanup();
      }
    });

    test("should include file metadata", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/list`,
        );
        const result = await response.json();

        const file = result.files[0];
        assertExists(file.name);
        assertExists(file.path);
        assertExists(file.type);
        assertTrue(file.type === "file" || file.type === "directory");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${fakeId}/files/list`,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, `Session ${fakeId} not found`);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/sessions/:sessionId/files/tree", () => {
    test("should get file tree", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/tree`,
        );
        const result = await response.json();

        assertExists(result.tree);
        assertExists(result.tree.name);
        assertExists(result.tree.type);
        assertEquals(result.tree.type, "directory");
        assertExists(result.tree.children);
        assertTrue(Array.isArray(result.tree.children));
      } finally {
        await ctx.cleanup();
      }
    });

    test("should respect maxDepth parameter", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Get tree with maxDepth=1 (should not include nested lib directory contents)
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/tree?maxDepth=1`,
        );
        const result = await response.json();

        assertExists(result.tree);
        assertExists(result.tree.children);

        // Should have root level items
        assertTrue(result.tree.children.length > 0);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should get tree for subdirectory", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: TEST_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/tree?path=src`,
        );
        const result = await response.json();

        assertExists(result.tree);
        assertEquals(result.tree.name, "src");
        assertEquals(result.tree.type, "directory");
        assertExists(result.tree.children);

        const childNames = result.tree.children.map((c: any) => c.name);
        assertTrue(childNames.includes("index.ts"));
        assertTrue(childNames.includes("utils.ts"));
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${fakeId}/files/tree`,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, `Session ${fakeId} not found`);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
