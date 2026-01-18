/**
 * SDK Session File Manager
 *
 * Manages the .jsonl session files created by Claude Agent SDK in ~/.claude/projects/
 * These files store the conversation history and can grow very large with tool outputs.
 *
 * File path structure:
 * ~/.claude/projects/{workspace-path-with-slashes-replaced}/{sdk-session-id}.jsonl
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Database } from "../storage/database";

/**
 * Get the SDK project directory for a workspace path
 * SDK replaces both / and . with - (e.g., /.liuboer/ -> --liuboer-)
 *
 * @param workspacePath - The session's workspace path
 * @returns Absolute path to the SDK project directory
 */
function getSDKProjectDir(workspacePath: string): string {
  const projectKey = workspacePath.replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", projectKey);
}

/**
 * Construct the path to the SDK session .jsonl file
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId
 * @returns Absolute path to the .jsonl file
 */
export function getSDKSessionFilePath(
  workspacePath: string,
  sdkSessionId: string,
): string {
  return join(getSDKProjectDir(workspacePath), `${sdkSessionId}.jsonl`);
}

/**
 * Find SDK session file by searching the workspace directory
 * Useful when we don't have the SDK session ID (e.g., session not currently running)
 *
 * @param workspacePath - The session's workspace path
 * @param liuboerSessionId - The Liuboer session ID to search for in files
 * @returns Path to the session file if found, null otherwise
 */
function findSDKSessionFile(
  workspacePath: string,
  liuboerSessionId: string,
): string | null {
  try {
    const sessionDir = getSDKProjectDir(workspacePath);

    if (!existsSync(sessionDir)) {
      return null;
    }

    // Search all .jsonl files for the Liuboer session ID
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));

    // Track all matching files with their modification times
    const matchingFiles: Array<{ path: string; mtime: number }> = [];

    for (const file of files) {
      const filePath = join(sessionDir, file);
      const content = readFileSync(filePath, "utf-8");

      // Check if this file contains the Liuboer session ID
      if (content.includes(liuboerSessionId)) {
        const stats = statSync(filePath);
        matchingFiles.push({ path: filePath, mtime: stats.mtimeMs });
      }
    }

    // Return the most recently modified file
    if (matchingFiles.length === 0) {
      return null;
    }

    matchingFiles.sort((a, b) => b.mtime - a.mtime);
    return matchingFiles[0].path;
  } catch (error) {
    console.error("[SDKSessionFileManager] Error finding session file:", error);
    return null;
  }
}

/**
 * Remove tool_result content from a specific message in the SDK session file
 *
 * Replaces large tool_result content with a placeholder to reduce file size
 * and unstick sessions with context overflow.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId (optional, will search if not provided)
 * @param messageUuid - The UUID of the message to modify
 * @param liuboerSessionId - The Liuboer session ID (for fallback search)
 * @returns true if successful, false otherwise
 */
export function removeToolResultFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null,
  messageUuid: string,
  liuboerSessionId?: string,
): boolean {
  try {
    let sessionFile: string | null = null;

    // Primary: Use SDK session ID for direct file path construction
    // This is 100% reliable - the filename IS the SDK session ID
    if (sdkSessionId) {
      sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
      if (!existsSync(sessionFile)) {
        console.error(
          `[SDKSessionFileManager] SDK session file not found: ${sessionFile}. SDK session may have been deleted.`,
        );
        return false;
      }
    }
    // Fallback: Search by Liuboer session ID (only when session not currently running)
    // This is less reliable as the same Liuboer ID can appear in 100+ SDK files
    else if (liuboerSessionId) {
      sessionFile = findSDKSessionFile(workspacePath, liuboerSessionId);
      if (!sessionFile) {
        console.error(
          "[SDKSessionFileManager] Could not find session file by searching for Liuboer session ID",
        );
        return false;
      }
    } else {
      console.error(
        "[SDKSessionFileManager] Neither SDK session ID nor Liuboer session ID provided",
      );
      return false;
    }

    // Read the .jsonl file (each line is a JSON object)
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    // Process each line to find and modify the target message
    let modified = false;
    let foundMessage = false;
    const updatedLines = lines.map((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;

      // Check if this is the target message
      if (message.uuid === messageUuid) {
        foundMessage = true;
        // Modify tool_result content in this message
        if (
          message.type === "user" &&
          message.message &&
          typeof message.message === "object" &&
          "content" in message.message &&
          Array.isArray(message.message.content)
        ) {
          const messageContent = message.message as Record<string, unknown>;
          const contentArray = messageContent.content as unknown[];

          messageContent.content = contentArray.map((block: unknown) => {
            const blockObj = block as Record<string, unknown>;
            if (blockObj.type === "tool_result") {
              modified = true;
              return {
                ...blockObj,
                content: [
                  {
                    type: "text",
                    text: "⚠️ Output removed by user. Run again with filter to narrow down the message.",
                  },
                ],
              };
            }
            return block;
          });
        }
      }

      return JSON.stringify(message);
    });

    if (!modified) {
      if (!foundMessage) {
        console.error(
          `[SDKSessionFileManager] Message UUID ${messageUuid} not found in session file. File contains ${lines.length} messages.`,
        );
      } else {
        console.error(
          `[SDKSessionFileManager] Message ${messageUuid} found but has no tool_result blocks`,
        );
      }
      return false;
    }

    // Write back to file
    writeFileSync(sessionFile, updatedLines.join("\n") + "\n", "utf-8");

    console.info(
      `[SDKSessionFileManager] Successfully removed tool_result from message ${messageUuid}`,
    );
    return true;
  } catch (error) {
    console.error(
      "[SDKSessionFileManager] Failed to remove tool_result:",
      error,
    );
    return false;
  }
}

/**
 * Result of SDK session file validation
 */
export interface SDKSessionValidationResult {
  valid: boolean;
  orphanedToolResults: Array<{
    toolUseId: string;
    messageUuid: string;
    lineIndex: number;
  }>;
  errors: string[];
}

/**
 * Result of SDK session file repair
 */
export interface SDKSessionRepairResult {
  success: boolean;
  backupPath: string | null;
  repairedCount: number;
  errors: string[];
}

/**
 * SDK message format in .jsonl file
 */
interface SDKFileMessage {
  type: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      tool_use_id?: string;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
}

/**
 * Validate SDK session file for orphaned tool_result blocks
 *
 * Checks that every tool_result has a corresponding tool_use in the conversation history.
 * SDK context compaction can sometimes remove tool_use blocks while keeping tool_results,
 * which causes API validation errors.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @returns Validation result with list of orphaned tool_results
 */
export function validateSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string,
): SDKSessionValidationResult {
  const result: SDKSessionValidationResult = {
    valid: true,
    orphanedToolResults: [],
    errors: [],
  };

  try {
    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    if (!existsSync(sessionFile)) {
      // No file means nothing to validate - this is OK for new sessions
      return result;
    }

    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    // Collect all tool_use IDs
    const toolUseIds = new Set<string>();
    // Collect all tool_result references
    const toolResultRefs: Array<{
      toolUseId: string;
      messageUuid: string;
      lineIndex: number;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const message = JSON.parse(lines[i]) as SDKFileMessage;

        // Collect tool_use IDs from assistant messages
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "tool_use" && block.id) {
              toolUseIds.add(block.id);
            }
          }
        }

        // Collect tool_result references from user messages
        if (message.type === "user" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              toolResultRefs.push({
                toolUseId: block.tool_use_id,
                messageUuid: message.uuid || "unknown",
                lineIndex: i,
              });
            }
          }
        }
      } catch (parseError) {
        result.errors.push(`Failed to parse line ${i}: ${parseError}`);
      }
    }

    // Find orphaned tool_results (those without matching tool_use)
    for (const ref of toolResultRefs) {
      if (!toolUseIds.has(ref.toolUseId)) {
        result.orphanedToolResults.push(ref);
        result.valid = false;
      }
    }

    if (!result.valid) {
      console.warn(
        `[SDKSessionFileManager] Found ${result.orphanedToolResults.length} orphaned tool_results in SDK session ${sdkSessionId}`,
      );
    }
  } catch (error) {
    result.valid = false;
    result.errors.push(`Validation error: ${error}`);
  }

  return result;
}

/**
 * Backup SDK session file before making changes
 *
 * @param sessionFilePath - Path to the session file
 * @returns Path to backup file, or null if backup failed
 */
function backupSDKSessionFile(sessionFilePath: string): string | null {
  try {
    const backupDir = join(dirname(sessionFilePath), "backups");
    mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = sessionFilePath.split("/").pop() || "session.jsonl";
    const backupPath = join(backupDir, `${fileName}.backup.${timestamp}`);

    copyFileSync(sessionFilePath, backupPath);
    console.info(`[SDKSessionFileManager] Created backup: ${backupPath}`);
    return backupPath;
  } catch (error) {
    console.error("[SDKSessionFileManager] Failed to create backup:", error);
    return null;
  }
}

/**
 * Repair SDK session file by inserting missing tool_use messages from Liuboer DB
 *
 * When SDK context compaction removes tool_use blocks while keeping tool_results,
 * this function attempts to repair the file by looking up the missing messages
 * from Liuboer's database and inserting them at the correct positions.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @param liuboerSessionId - The Liuboer session ID (for DB lookup)
 * @param db - Database instance for message lookup
 * @returns Repair result with backup path and count of repaired messages
 */
export function repairSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string,
  liuboerSessionId: string,
  db: Database,
): SDKSessionRepairResult {
  const result: SDKSessionRepairResult = {
    success: false,
    backupPath: null,
    repairedCount: 0,
    errors: [],
  };

  try {
    // First validate to find orphaned tool_results
    const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

    if (validation.valid) {
      result.success = true;
      return result; // Nothing to repair
    }

    if (validation.errors.length > 0) {
      result.errors.push(...validation.errors);
    }

    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    // Create backup before modifying
    result.backupPath = backupSDKSessionFile(sessionFile);
    if (!result.backupPath) {
      result.errors.push("Failed to create backup - aborting repair");
      return result;
    }

    // Read the file
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    // For each orphaned tool_result, try to find and insert the missing tool_use
    const insertions: Array<{ lineIndex: number; message: string }> = [];

    for (const orphan of validation.orphanedToolResults) {
      // Look up the tool_use message from Liuboer DB by searching for the tool_use_id
      // Note: db.getSDKMessages returns up to 100 messages by default, increase limit to search more
      const dbMessages = db.getSDKMessages(liuboerSessionId, 10000);

      let missingAssistantMsg: SDKFileMessage | null = null;
      let missingMsgTimestamp: string | null = null;

      for (const dbMsg of dbMessages) {
        // SDKMessage from DB is already parsed - cast to our local SDKFileMessage type
        const parsedMsg = dbMsg as unknown as SDKFileMessage & {
          timestamp?: number;
        };
        if (parsedMsg.type === "assistant" && parsedMsg.message?.content) {
          for (const block of parsedMsg.message.content) {
            if (block.type === "tool_use" && block.id === orphan.toolUseId) {
              missingAssistantMsg = parsedMsg;
              // timestamp is injected by the repository as a number (milliseconds)
              missingMsgTimestamp = parsedMsg.timestamp
                ? new Date(parsedMsg.timestamp).toISOString()
                : new Date().toISOString();
              break;
            }
          }
        }
        if (missingAssistantMsg) break;
      }

      if (!missingAssistantMsg) {
        result.errors.push(
          `Could not find tool_use message for ${orphan.toolUseId} in Liuboer DB`,
        );
        continue;
      }

      // Get the orphaned message to extract metadata for the repaired message
      const orphanedLine = JSON.parse(
        lines[orphan.lineIndex],
      ) as SDKFileMessage;

      // Build the repaired SDK file message format
      const repairedMsg: SDKFileMessage = {
        parentUuid: orphanedLine.parentUuid, // Will need adjustment
        isSidechain: false,
        userType: "external",
        cwd: orphanedLine.cwd || workspacePath,
        sessionId: sdkSessionId,
        version: orphanedLine.version || "2.1.1",
        gitBranch: orphanedLine.gitBranch,
        slug: orphanedLine.slug,
        message: missingAssistantMsg.message,
        requestId: `req_recovered_${missingAssistantMsg.uuid?.slice(0, 8) || "unknown"}`,
        type: "assistant",
        uuid: missingAssistantMsg.uuid,
        timestamp: missingMsgTimestamp || new Date().toISOString(),
      };

      // Find the correct insertion point (before the orphaned tool_result)
      // And update the parentUuid of the orphaned message to point to the repaired message
      insertions.push({
        lineIndex: orphan.lineIndex,
        message: JSON.stringify(repairedMsg),
      });

      // Update the orphaned message's parentUuid to point to the repaired message
      if (missingAssistantMsg.uuid) {
        const updatedOrphan = {
          ...orphanedLine,
          parentUuid: missingAssistantMsg.uuid,
        };
        lines[orphan.lineIndex] = JSON.stringify(updatedOrphan);
      }

      result.repairedCount++;
    }

    // Insert messages in reverse order (to preserve line indices)
    insertions.sort((a, b) => b.lineIndex - a.lineIndex);
    for (const insertion of insertions) {
      lines.splice(insertion.lineIndex, 0, insertion.message);
    }

    // Write back to file
    writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");

    result.success = result.repairedCount > 0;

    if (result.success) {
      console.info(
        `[SDKSessionFileManager] Repaired ${result.repairedCount} orphaned tool_results in SDK session ${sdkSessionId}`,
      );
    }
  } catch (error) {
    result.errors.push(`Repair error: ${error}`);
    console.error("[SDKSessionFileManager] Repair failed:", error);
  }

  return result;
}

/**
 * Validate and auto-repair SDK session file before resuming
 *
 * This is the main entry point for session resume validation.
 * It validates the SDK session file and attempts auto-repair if needed.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @param liuboerSessionId - The Liuboer session ID (for DB lookup)
 * @param db - Database instance for message lookup
 * @returns true if session is valid (or was repaired), false if unrecoverable
 */
export function validateAndRepairSDKSession(
  workspacePath: string,
  sdkSessionId: string,
  liuboerSessionId: string,
  db: Database,
): boolean {
  // First validate
  const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

  if (validation.valid) {
    return true;
  }

  console.warn(
    `[SDKSessionFileManager] SDK session ${sdkSessionId} has ${validation.orphanedToolResults.length} orphaned tool_results - attempting auto-repair`,
  );

  // Attempt repair
  const repair = repairSDKSessionFile(
    workspacePath,
    sdkSessionId,
    liuboerSessionId,
    db,
  );

  if (repair.success) {
    console.info(
      `[SDKSessionFileManager] Auto-repair successful. Repaired ${repair.repairedCount} messages. Backup: ${repair.backupPath}`,
    );
    return true;
  }

  // Repair failed - log errors
  console.error(
    `[SDKSessionFileManager] Auto-repair failed for SDK session ${sdkSessionId}:`,
    repair.errors,
  );
  return false;
}
