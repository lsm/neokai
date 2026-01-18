# Agent Session Refactoring Plan

This document outlines the refactoring plan for `agent-session.ts` to reduce its size and improve maintainability.

## Current State

| Metric                    | Value                            |
| ------------------------- | -------------------------------- |
| **Total lines**           | 1,919                            |
| **Largest method**        | `runQuery()` - 375 lines         |
| **Message methods**       | 5 (overlapping responsibilities) |
| **Restart/reset methods** | 3 (duplicated logic)             |

## Target State

| Metric           | Value            |
| ---------------- | ---------------- |
| **Target lines** | ~1,450           |
| **Reduction**    | ~24% (460 lines) |

---

## Problem Block 1: Monolithic `runQuery()` (Lines 798-1175)

### Current Structure

```
runQuery() - 375 lines
├── Auth check (15 lines)
├── Workspace mkdir (5 lines)
├── System prompt building (70 lines) ← EXTRACT
│   └── Worktree isolation text (30 lines of template)
├── Tool config (30 lines) ← EXTRACT
├── Settings sources (15 lines) ← EXTRACT
├── MCP config (15 lines) ← EXTRACT
├── SDK options assembly (50 lines) ← EXTRACT
├── Resume + thinking tokens (20 lines)
├── Query creation (10 lines)
├── Message processing loop (35 lines)
├── Error handling (65 lines)
└── Finally block (10 lines)
```

### Recommendation: Extract `QueryOptionsBuilder`

Create `packages/daemon/src/lib/query-options-builder.ts`:

```typescript
import type { Options } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session } from '@liuboer/shared';
import type { SettingsManager } from './settings-manager';

export class QueryOptionsBuilder {
	constructor(
		private session: Session,
		private settingsManager: SettingsManager,
	) {}

	async build(): Promise<Options> {
		const toolsConfig = this.session.config.tools;

		return {
			...(await this.getSettingsOptions()),
			model: this.session.config.model,
			cwd: this.getCwd(),
			additionalDirectories: this.getAdditionalDirectories(),
			permissionMode: 'bypassPermissions',
			allowDangerouslySkipPermissions: true,
			maxTurns: Infinity,
			settingSources: this.getSettingSources(),
			systemPrompt: this.buildSystemPrompt(),
			disallowedTools: this.getDisallowedTools(),
			hooks: this.buildHooks(),
		};
	}

	private getCwd(): string {
		return this.session.worktree ? this.session.worktree.worktreePath : this.session.workspacePath;
	}

	private buildSystemPrompt(): Options['systemPrompt'] {
		const toolsConfig = this.session.config.tools;
		const useClaudeCodePreset = toolsConfig?.useClaudeCodePreset ?? true;

		if (useClaudeCodePreset) {
			const config: Options['systemPrompt'] = {
				type: 'preset',
				preset: 'claude_code',
			};

			if (this.session.worktree) {
				config.append = this.getWorktreeIsolationText();
			}

			return config;
		}

		// No Claude Code preset
		if (this.session.worktree) {
			return this.getMinimalWorktreePrompt();
		}

		return undefined;
	}

	private getWorktreeIsolationText(): string {
		const wt = this.session.worktree!;
		return `
IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository: ${wt.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${wt.worktreePath}
2. NEVER modify files in the main repository at: ${wt.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
4. Do NOT attempt to access or modify files outside the worktree path

ALLOWED GIT OPERATIONS ON ROOT REPOSITORY:
To merge changes from this session branch into the main branch of the root repository:

git --git-dir=${wt.mainRepoPath}/.git --work-tree=${wt.mainRepoPath} merge ${wt.branch}

To push the main branch to remote:

git --git-dir=${wt.mainRepoPath}/.git --work-tree=${wt.mainRepoPath} push origin main

These commands operate on the root repository without violating worktree isolation.
This isolation ensures concurrent sessions don't conflict with each other.
`.trim();
	}

	private getMinimalWorktreePrompt(): string {
		const wt = this.session.worktree!;
		return `
You are an AI assistant helping with coding tasks.

IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository: ${wt.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${wt.worktreePath}
2. NEVER modify files in the main repository at: ${wt.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
`.trim();
	}

	private getDisallowedTools(): string[] | undefined {
		const toolsConfig = this.session.config.tools;
		const disallowedTools: string[] = [];

		if (!toolsConfig?.liuboerTools?.memory) {
			disallowedTools.push('liuboer__memory__*');
		}

		return disallowedTools.length > 0 ? disallowedTools : undefined;
	}

	private getSettingSources(): Options['settingSources'] {
		const toolsConfig = this.session.config.tools;
		const loadSettingSources = toolsConfig?.loadSettingSources ?? true;
		return loadSettingSources ? ['project', 'local'] : ['local'];
	}

	private getAdditionalDirectories(): string[] | undefined {
		// Worktree sessions: restrict to cwd only
		// Non-worktree: allow access to any file
		return this.session.worktree ? [] : undefined;
	}

	private async getSettingsOptions(): Promise<Partial<Options>> {
		const toolsConfig = this.session.config.tools;
		return await this.settingsManager.prepareSDKOptions({
			disabledMcpServers: toolsConfig?.disabledMcpServers ?? [],
		});
	}

	private buildHooks(): Options['hooks'] {
		const {
			createOutputLimiterHook,
			getOutputLimiterConfigFromSettings,
		} = require('./output-limiter-hook');

		const globalSettings = this.settingsManager.getGlobalSettings();
		const outputLimiterConfig = getOutputLimiterConfigFromSettings(globalSettings);
		const outputLimiterHook = createOutputLimiterHook(outputLimiterConfig);

		return {
			PreToolUse: [{ hooks: [outputLimiterHook] }],
		};
	}
}
```

**Lines saved:** ~180 lines

---

## Problem Block 2: Overlapping Message Methods

### Current Methods

| Method                     | Lines | Used By                  | Purpose                     |
| -------------------------- | ----- | ------------------------ | --------------------------- |
| `sendMessage()`            | 3     | **Nothing** (deprecated) | Wrapper                     |
| `persistUserMessage()`     | 60    | RPC handler              | Instant persist + broadcast |
| `startQueryAndEnqueue()`   | 60    | EventBus subscriber      | Start query + enqueue       |
| `persistAndQueueMessage()` | 135   | 2 unit tests             | Combined (duplicates above) |
| `handleMessageSend()`      | 110   | 15+ integration tests    | Sync all-in-one for tests   |

### Production Message Flow

```
RPC handler (session-handlers.ts)
  │
  ├── agentSession.persistUserMessage() ← Instant (< 10ms)
  │   └── Save to DB + broadcast to UI
  │
  ├── eventBus.emit('user-message:persisted') ← Fire-and-forget
  │
  └── return { messageId } ← Fast RPC response

EventBus subscriber (session-manager.ts)
  │
  └── agentSession.startQueryAndEnqueue() ← Heavy work (async)
      └── Start SDK query + enqueue message
```

### Recommendation

1. **REMOVE** `sendMessage()` - Unused, deprecated
2. **REMOVE** `persistAndQueueMessage()` - Duplicates production path
3. **KEEP** `persistUserMessage()` - Production RPC uses it
4. **KEEP** `startQueryAndEnqueue()` - Production EventBus uses it
5. **KEEP** `handleMessageSend()` - Tests need synchronous await pattern

### Test Updates Required

Update `instant-message-persistence.test.ts` to use `handleMessageSend()` instead of `persistAndQueueMessage()`.

**Lines saved:** ~140 lines

---

## Problem Block 3: Query Restart/Reset Duplication

### Current Methods

| Method              | Lines | Purpose                              |
| ------------------- | ----- | ------------------------------------ |
| `restartQuery()`    | 25    | Smart restart (defers if processing) |
| `doActualRestart()` | 47    | Execute restart steps                |
| `resetQuery()`      | 90    | Forceful reset (user-initiated)      |

### Shared Steps (Duplicated)

```
1. Stop message queue
2. Interrupt query
3. Wait for termination (with timeout)
4. Clear query object
5. Start fresh query
```

### Recommendation: Extract `QueryLifecycleManager`

Create `packages/daemon/src/lib/query-lifecycle-manager.ts`:

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MessageQueue } from './message-queue';
import type { Logger } from './logger';

const TERMINATION_TIMEOUT_MS = 5000;
const RESET_TIMEOUT_MS = 3000;

export class QueryLifecycleManager {
	constructor(
		private messageQueue: MessageQueue,
		private getQueryObject: () => Query | null,
		private setQueryObject: (q: Query | null) => void,
		private getQueryPromise: () => Promise<void> | null,
		private setQueryPromise: (p: Promise<void> | null) => void,
		private startStreamingQuery: () => Promise<void>,
		private logger: Logger,
	) {}

	/**
	 * Stop the current query (shared logic)
	 */
	async stop(timeoutMs: number = TERMINATION_TIMEOUT_MS): Promise<void> {
		// 1. Stop message queue
		this.messageQueue.stop();
		this.logger.log('Message queue stopped');

		// 2. Interrupt current query
		const queryObject = this.getQueryObject();
		if (queryObject && typeof queryObject.interrupt === 'function') {
			try {
				await queryObject.interrupt();
				this.logger.log('Query interrupted successfully');
			} catch (error) {
				this.logger.warn('Query interrupt failed:', error);
			}
		}

		// 3. Wait for termination
		const queryPromise = this.getQueryPromise();
		if (queryPromise) {
			try {
				await Promise.race([
					queryPromise.catch((e) => this.logger.warn('Query promise rejected:', e)),
					new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				]);
				this.logger.log('Previous query terminated');
			} catch (error) {
				this.logger.warn('Error waiting for query termination:', error);
			}
		}

		// 4. Clear references
		this.setQueryObject(null);
		this.setQueryPromise(null);
	}

	/**
	 * Restart the query (stop + start)
	 */
	async restart(): Promise<void> {
		this.logger.log('Executing query restart...');
		await this.stop();
		await this.startStreamingQuery();
		this.logger.log('Query restarted successfully');
	}

	/**
	 * Full reset with additional cleanup
	 */
	async reset(
		options: {
			restartAfter?: boolean;
			onBeforeStop?: () => Promise<void>;
		} = {},
	): Promise<{ success: boolean; error?: string }> {
		const { restartAfter = true, onBeforeStop } = options;

		try {
			// Execute pre-stop cleanup
			if (onBeforeStop) {
				await onBeforeStop();
			}

			// Stop the query
			await this.stop(RESET_TIMEOUT_MS);

			// Optionally restart
			if (restartAfter) {
				this.logger.log('Starting fresh query...');
				await new Promise((resolve) => setTimeout(resolve, 100));
				await this.startStreamingQuery();
				this.logger.log('Fresh query started successfully');
			}

			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error('Query reset failed:', error);
			return { success: false, error: errorMessage };
		}
	}
}
```

**Lines saved:** ~80 lines

---

## Problem Block 4: Inline Worktree Prompt Template

The worktree isolation prompt is 30+ lines of inline template string.

**Already handled in QueryOptionsBuilder above.**

---

## Problem Block 5: Duplicate Error Display Logic

### Current Methods

- `handleApiValidationError()` - 65 lines
- `handleCircuitBreakerTrip()` - 65 lines

Both create synthetic assistant messages with ~40% shared logic.

### Recommendation: Extract Shared Helper

```typescript
private createErrorAssistantMessage(
  title: string,
  details: string,
  suggestions?: string[]
): SDKMessage {
  const suggestionsText = suggestions
    ? '\n\n**What to do:**\n' + suggestions.map(s => `- ${s}`).join('\n')
    : '';

  return {
    type: 'assistant' as const,
    uuid: generateUUID() as UUID,
    session_id: this.session.id,
    parent_tool_use_id: null,
    message: {
      role: 'assistant' as const,
      content: [{
        type: 'text' as const,
        text: `**${title}**\n\n${details}${suggestionsText}`,
      }],
    },
  };
}
```

**Lines saved:** ~30 lines

---

## Implementation Phases

### Phase 1: QueryOptionsBuilder (Priority: HIGH)

**Risk:** Low
**Effort:** Medium
**Lines saved:** ~180

1. Create `query-options-builder.ts`
2. Move all options building logic
3. Update `runQuery()` to use builder
4. Run full test suite

### Phase 2: Remove Dead Code (Priority: HIGH)

**Risk:** Low
**Effort:** Low
**Lines saved:** ~140

1. Remove `sendMessage()`
2. Update 2 tests to use `handleMessageSend()`
3. Remove `persistAndQueueMessage()`
4. Run full test suite

### Phase 3: QueryLifecycleManager (Priority: MEDIUM)

**Risk:** Medium
**Effort:** Medium
**Lines saved:** ~80

1. Create `query-lifecycle-manager.ts`
2. Refactor `restartQuery()`, `doActualRestart()`, `resetQuery()`
3. Run full test suite (especially reset/restart tests)

### Phase 4: Error Helper (Priority: LOW)

**Risk:** Low
**Effort:** Low
**Lines saved:** ~30

1. Extract `createErrorAssistantMessage()` helper
2. Refactor `handleApiValidationError()` and `handleCircuitBreakerTrip()`

---

## Test Impact

| Test File                             | Methods Used               | Impact            |
| ------------------------------------- | -------------------------- | ----------------- |
| `agent-session-sdk.test.ts`           | `handleMessageSend()`      | None              |
| `auto-title.test.ts`                  | `handleMessageSend()`      | None              |
| `message-persistence.test.ts`         | `handleMessageSend()`      | None              |
| `instant-message-persistence.test.ts` | `persistAndQueueMessage()` | **Update needed** |

---

## Summary

| Phase     | Extraction              | Lines Saved | Risk   | Effort |
| --------- | ----------------------- | ----------- | ------ | ------ |
| **1**     | `QueryOptionsBuilder`   | ~180        | Low    | Medium |
| **2**     | Remove dead methods     | ~140        | Low    | Low    |
| **3**     | `QueryLifecycleManager` | ~80         | Medium | Medium |
| **4**     | Error helper            | ~30         | Low    | Low    |
| **Total** |                         | **~430**    |        |        |

**Final `agent-session.ts`:** ~1,490 lines (22% reduction)
