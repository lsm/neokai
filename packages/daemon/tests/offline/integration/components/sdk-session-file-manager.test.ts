/**
 * Unit tests for SDK Session File Manager
 *
 * Tests the path encoding logic that matches the Claude SDK's behavior.
 */

import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSDKSessionFilePath } from "../../../../src/lib/sdk-session-file-manager.ts";

describe("SDK Session File Manager", () => {
  describe("getSDKSessionFilePath", () => {
    it("should encode simple paths correctly", () => {
      const result = getSDKSessionFilePath("/Users/alice/project", "sdk-123");
      expect(result).toBe(
        join(
          homedir(),
          ".claude",
          "projects",
          "-Users-alice-project",
          "sdk-123.jsonl",
        ),
      );
    });

    it("should encode paths with dots (like .liuboer) correctly", () => {
      // This is the key test - dots should be replaced with dashes
      const result = getSDKSessionFilePath(
        "/Users/lsm/.liuboer/projects/-Users-lsm-focus-liuboer/worktrees/abc123",
        "sdk-456",
      );
      expect(result).toBe(
        join(
          homedir(),
          ".claude",
          "projects",
          "-Users-lsm--liuboer-projects--Users-lsm-focus-liuboer-worktrees-abc123",
          "sdk-456.jsonl",
        ),
      );
    });

    it("should handle multiple dots in path", () => {
      const result = getSDKSessionFilePath(
        "/home/user/.config/.app/data",
        "sdk-789",
      );
      expect(result).toBe(
        join(
          homedir(),
          ".claude",
          "projects",
          "-home-user--config--app-data",
          "sdk-789.jsonl",
        ),
      );
    });

    it("should handle paths without dots", () => {
      const result = getSDKSessionFilePath("/var/lib/project", "sdk-abc");
      expect(result).toBe(
        join(
          homedir(),
          ".claude",
          "projects",
          "-var-lib-project",
          "sdk-abc.jsonl",
        ),
      );
    });

    it("should handle consecutive slashes", () => {
      // Edge case: consecutive slashes become consecutive dashes
      const result = getSDKSessionFilePath("/Users//double/slash", "sdk-def");
      expect(result).toBe(
        join(
          homedir(),
          ".claude",
          "projects",
          "-Users--double-slash",
          "sdk-def.jsonl",
        ),
      );
    });
  });
});
