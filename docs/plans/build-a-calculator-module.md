# Plan: Build a Calculator Module

## Goal Summary

Create two minimal TypeScript source files under `src/calc/` that export arithmetic functions. No tests, no configuration, and no build tooling are required. Each file is a standalone named-export module using idiomatic TypeScript with explicit `number` types.

## Assumptions

> **Note:** This plan assumes an existing TypeScript project with a `src/` directory and a `tsconfig.json` in place. The two new files will be syntactically valid TypeScript and will integrate cleanly once that baseline exists.

## Approach

Two independent coding tasks, one per file. Each task creates the `src/calc/` directory (if not yet present) and writes the corresponding `.ts` file. The tasks have no dependency on each other and can be executed in any order.

---

## Tasks

### Task 1: Create src/calc/add.ts

**Agent type:** coder

**Description:**
Create the file `src/calc/add.ts` that exports a single named function `add`.

**Subtasks (ordered implementation steps):**
1. Run `mkdir -p src/calc/` to ensure the directory exists.
2. Write `src/calc/add.ts` with the following content:
   ```ts
   export function add(a: number, b: number): number {
     return a + b;
   }
   ```
3. Verify the file is saved and the export signature matches exactly: `add(a: number, b: number): number`.

**Acceptance criteria:**
- `src/calc/add.ts` exists in the repository.
- The file exports a named function `add(a: number, b: number): number`.
- No other files are created or modified.

**Depends on:** none

---

### Task 2: Create src/calc/subtract.ts

**Agent type:** coder

**Description:**
Create the file `src/calc/subtract.ts` that exports a single named function `subtract`.

**Subtasks (ordered implementation steps):**
1. Run `mkdir -p src/calc/` to ensure the directory exists.
2. Write `src/calc/subtract.ts` with the following content:
   ```ts
   export function subtract(a: number, b: number): number {
     return a - b;
   }
   ```
3. Verify the file is saved and the export signature matches exactly: `subtract(a: number, b: number): number`.

**Acceptance criteria:**
- `src/calc/subtract.ts` exists in the repository.
- The file exports a named function `subtract(a: number, b: number): number`.
- No other files are created or modified.

**Depends on:** none
