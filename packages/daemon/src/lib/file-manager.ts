/**
 * File Manager - Handles file system operations with security
 *
 * Provides safe file read/list/tree operations with path traversal protection.
 */

import { join, normalize, relative } from "@std/path";
import { exists, walk } from "@std/fs";

export interface FileInfo {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

export interface FileTree {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTree[];
}

export class FileManager {
  constructor(private workspacePath: string) {}

  /**
   * Validate that a path is within the workspace (prevent path traversal)
   */
  private validatePath(targetPath: string): string {
    const normalizedWorkspace = normalize(this.workspacePath);
    const normalizedTarget = normalize(join(this.workspacePath, targetPath));

    const rel = relative(normalizedWorkspace, normalizedTarget);

    if (rel.startsWith("..") || rel === "..") {
      throw new Error("Path traversal detected - access denied");
    }

    return normalizedTarget;
  }

  /**
   * Read file content
   */
  async readFile(
    filePath: string,
    encoding: "utf-8" | "base64" = "utf-8",
  ): Promise<{
    path: string;
    content: string;
    encoding: string;
    size: number;
    mtime: string;
  }> {
    const absolutePath = this.validatePath(filePath);

    if (!(await exists(absolutePath))) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = await Deno.stat(absolutePath);
    if (stat.isDirectory) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    let content: string;
    if (encoding === "base64") {
      const bytes = await Deno.readFile(absolutePath);
      content = btoa(String.fromCharCode(...bytes));
    } else {
      content = await Deno.readTextFile(absolutePath);
    }

    return {
      path: filePath,
      content,
      encoding,
      size: stat.size,
      mtime: stat.mtime?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * List directory contents
   */
  async listDirectory(
    dirPath: string = ".",
    recursive: boolean = false,
  ): Promise<FileInfo[]> {
    const absolutePath = this.validatePath(dirPath);

    if (!(await exists(absolutePath))) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const stat = await Deno.stat(absolutePath);
    if (!stat.isDirectory) {
      throw new Error(`Path is not a directory: ${dirPath}`);
    }

    const files: FileInfo[] = [];

    if (recursive) {
      for await (const entry of walk(absolutePath)) {
        const relativePath = relative(this.workspacePath, entry.path);
        files.push({
          path: relativePath,
          name: entry.name,
          type: entry.isDirectory ? "directory" : "file",
          size: entry.isFile ? (await Deno.stat(entry.path)).size : undefined,
          mtime: (await Deno.stat(entry.path)).mtime?.toISOString(),
        });
      }
    } else {
      for await (const entry of Deno.readDir(absolutePath)) {
        const entryPath = join(absolutePath, entry.name);
        const stat = await Deno.stat(entryPath);
        const relativePath = relative(this.workspacePath, entryPath);

        files.push({
          path: relativePath,
          name: entry.name,
          type: entry.isDirectory ? "directory" : "file",
          size: entry.isFile ? stat.size : undefined,
          mtime: stat.mtime?.toISOString(),
        });
      }
    }

    return files.sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get file tree for UI (with max depth)
   */
  async getFileTree(
    dirPath: string = ".",
    maxDepth: number = 3,
    currentDepth: number = 0,
  ): Promise<FileTree> {
    const absolutePath = this.validatePath(dirPath);

    if (!(await exists(absolutePath))) {
      throw new Error(`Path not found: ${dirPath}`);
    }

    const stat = await Deno.stat(absolutePath);
    const name = dirPath === "." ? this.workspacePath.split("/").pop() || "workspace" : dirPath.split("/").pop() || dirPath;

    if (!stat.isDirectory) {
      return {
        name,
        path: dirPath,
        type: "file",
      };
    }

    const tree: FileTree = {
      name,
      path: dirPath,
      type: "directory",
      children: [],
    };

    // Stop recursion at max depth
    if (currentDepth >= maxDepth) {
      return tree;
    }

    const entries: FileInfo[] = [];
    for await (const entry of Deno.readDir(absolutePath)) {
      // Skip hidden files and common ignore patterns
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "dist", "build", "coverage"].includes(entry.name)) {
        continue;
      }

      const entryPath = join(absolutePath, entry.name);
      const relativePath = relative(this.workspacePath, entryPath);

      entries.push({
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory ? "directory" : "file",
      });
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Recursively build tree
    for (const entry of entries) {
      if (entry.type === "directory") {
        const subtree = await this.getFileTree(
          entry.path,
          maxDepth,
          currentDepth + 1,
        );
        tree.children!.push(subtree);
      } else {
        tree.children!.push({
          name: entry.name,
          path: entry.path,
          type: "file",
        });
      }
    }

    return tree;
  }

  /**
   * Check if path exists
   */
  async pathExists(filePath: string): Promise<boolean> {
    try {
      const absolutePath = this.validatePath(filePath);
      return await exists(absolutePath);
    } catch {
      return false;
    }
  }

  /**
   * Get workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }
}
