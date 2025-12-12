# Model Caching Architecture

## Overview

This document describes the dynamic model loading system with TTL-based lazy cache refresh implemented in the Liuboer daemon.

**Important:** The model list is solely sourced from the SDK's `supportedModels()` API. There is no static model fallback.

## Architecture

### 1. Model Loading Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Startup                      │
│  initializeModels() → Loads models from SDK → Global Cache   │
│  ⚠️  App fails to start if SDK models cannot be loaded       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      Global Model Cache                      │
│  - Key: 'global'                                             │
│  - Contains: SDK ModelInfo[] from supportedModels()          │
│  - Timestamp: Last refresh time                              │
│  - TTL: 4 hours                                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              getAvailableModels() - Lazy Refresh             │
│  1. Return cached models immediately                         │
│  2. If cache > 4 hours old:                                  │
│     - Trigger background refresh (non-blocking)              │
│     - Continue returning stale cache                         │
│  3. Background refresh updates cache when complete           │
└─────────────────────────────────────────────────────────────┘
```

### 2. SDK Model Format

The SDK returns models with short identifiers:

| SDK ID    | Display Name          | Family |
| --------- | --------------------- | ------ |
| `default` | Default (recommended) | sonnet |
| `opus`    | Opus                  | opus   |
| `haiku`   | Haiku                 | haiku  |

### 3. Legacy Model ID Support

For backward compatibility with existing sessions, the service maps legacy model IDs to current SDK IDs:

```typescript
const LEGACY_MODEL_MAPPINGS = {
	// Old alias
	sonnet: 'default',
	// Full model IDs
	'claude-sonnet-4-5-20250929': 'default',
	'claude-opus-4-5-20251101': 'opus',
	'claude-haiku-4-5-20251001': 'haiku',
	// ... more mappings
};
```

### 4. Key Components

#### `model-service.ts`

**Cache Storage:**

- `modelsCache: Map<string, SDKModelInfo[]>` - Cached models by key
- `cacheTimestamps: Map<string, number>` - Timestamp tracking for freshness
- `refreshInProgress: Map<string, Promise<void>>` - Prevents duplicate refreshes
- `CACHE_TTL = 4 hours` - Time-to-live for cache entries

**Functions:**

```typescript
// Initialize models on app startup (REQUIRED - called once)
export async function initializeModels(): Promise<void>;

// Get available models with lazy refresh
export function getAvailableModels(cacheKey = 'global'): ModelInfo[];

// Get model info by ID (supports legacy IDs via mapping)
export async function getModelInfo(idOrAlias: string): Promise<ModelInfo | null>;

// Clear cache (for testing or manual refresh)
export function clearModelsCache(cacheKey?: string): void;
```

#### `app.ts`

Models are loaded during app initialization:

```typescript
// Initialize dynamic models on app startup
log('Loading dynamic models from Claude SDK...');
const { initializeModels } = await import('./lib/model-service');
await initializeModels(); // Throws if SDK fails
log('✅ Model service initialized');
```

### 5. Cache Refresh Flow

```
User Request → getAvailableModels()
                     │
                     ├─→ Check cache exists?
                     │   ├─→ NO → Return empty (error logged)
                     │   └─→ YES → Continue
                     │
                     ├─→ Check cache stale (>4 hours)?
                     │   ├─→ NO → Return cache
                     │   └─→ YES → Continue
                     │
                     ├─→ Trigger background refresh
                     │   (non-blocking, async)
                     │
                     └─→ Return current cache immediately
                         (user gets response without waiting)

Background Refresh:
  1. Check if refresh already in progress → Skip if yes
  2. Create temporary SDK query
  3. Call query.supportedModels()
  4. Update cache with new models
  5. Update timestamp
  6. Cleanup query
  7. Remove refresh lock
```

### 6. Error Handling

**Initialization Errors:**

- If `initializeModels()` fails, the error is thrown
- App startup will fail - models are required
- User must fix authentication/network issues

**Background Refresh Errors:**

- Errors are logged but not thrown
- Existing cache continues to be served
- Next call after TTL will retry refresh

### 7. Performance Characteristics

**Cache Hit (Typical Case):**

- Response time: <1ms (in-memory Map lookup)
- No network calls
- No SDK initialization

**Cache Miss (First Load):**

- Response time: ~2-3 seconds (SDK query creation + API call)
- One-time cost per app lifecycle
- Subsequent calls are instant

**Background Refresh (After TTL):**

- User-perceived latency: 0ms (returns stale cache)
- Background task: ~2-3 seconds
- Transparent to users

## Configuration

**Default Model:**

The config default model is `'default'` which maps to Sonnet in the SDK:

```typescript
// In config.ts
defaultModel: process.env.DEFAULT_MODEL || 'default',
```

**Cache TTL:**

```typescript
// In model-service.ts
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
```

## Monitoring

**Startup Logs:**

```
Loading dynamic models from Claude SDK...
[model-service] Loading models on app startup...
[model-service] Startup initialization complete: 4 models loaded
✅ Model service initialized
```

**Background Refresh Logs:**

```
[model-service] Background refresh complete: 4 models loaded
```

**Error Logs:**

```
[model-service] Failed to load models on startup: [error]
// App will fail to start
```

## Testing

**Manual Testing:**

```bash
bun run packages/daemon/tests/manual/test-model-cache.ts
```

**Integration Tests:**

- `tests/integration/session-rpc.test.ts` - Validates model IDs
- `tests/integration/model-switching.test.ts` - Tests model switching
