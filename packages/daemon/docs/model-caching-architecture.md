# Model Caching Architecture

## Overview

This document describes the hybrid dynamic/static model loading system with TTL-based lazy cache refresh implemented in the Liuboer daemon.

## Architecture

### 1. Multi-Level Caching Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Startup                      │
│  initializeModels() → Loads models from SDK → Global Cache   │
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
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Static Model Fallback                     │
│  - Used when:                                                │
│    * SDK loading fails                                       │
│    * Cache is empty                                          │
│    * Network issues                                          │
│  - Contains: Hardcoded latest models (Opus, Sonnet, Haiku)   │
└─────────────────────────────────────────────────────────────┘
```

### 2. Key Components

#### `model-service.ts`

**Cache Storage:**

- `modelsCache: Map<string, SDKModelInfo[]>` - Cached models by key
- `cacheTimestamps: Map<string, number>` - Timestamp tracking for freshness
- `refreshInProgress: Map<string, Promise<void>>` - Prevents duplicate refreshes
- `CACHE_TTL = 4 hours` - Time-to-live for cache entries

**Functions:**

```typescript
// Initialize models on app startup (called once)
export async function initializeModels(): Promise<void>;

// Get available models with lazy refresh
export function getAvailableModels(cacheKey = 'global'): ModelInfo[];

// Load models from SDK query object
export async function getSupportedModelsFromQuery(
	queryObject: Query | null,
	cacheKey: string = 'global'
): Promise<SDKModelInfo[]>;

// Clear cache (for testing or manual refresh)
export function clearModelsCache(cacheKey?: string): void;

// Background refresh (internal, triggered by getAvailableModels)
async function triggerBackgroundRefresh(cacheKey: string): Promise<void>;

// Check if cache is stale (internal)
function isCacheStale(cacheKey: string): boolean;
```

#### `app.ts`

Models are loaded during app initialization:

```typescript
// Initialize dynamic models on app startup (global cache fallback)
log('Loading dynamic models from Claude SDK...');
const { initializeModels } = await import('./lib/model-service');
await initializeModels();
log('✅ Model service initialized');
```

#### `session-manager.ts`

Session creation validates models against the cache:

```typescript
async createSession(params) {
  // Validate and resolve model ID using cached models
  const modelId = await this.getValidatedModelId(params.config?.model);

  const session: Session = {
    config: {
      model: modelId, // Use validated model ID
      ...
    },
    ...
  };
}
```

### 3. Cache Refresh Flow

```
User Request → getAvailableModels()
                     │
                     ├─→ Check cache exists?
                     │   ├─→ NO → Return static fallback
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

### 4. Error Handling

**Initialization Errors:**

- If `initializeModels()` fails, log error and continue
- App will fall back to static models
- Next call to `getAvailableModels()` will retry loading

**Background Refresh Errors:**

- Errors are logged but not thrown
- Existing cache continues to be served
- Next call after TTL will retry refresh

**Query Creation Errors:**

- Temporary query cleanup is always executed in finally block
- Errors during cleanup are silently ignored

### 5. Performance Characteristics

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

### 6. Testing

**Integration Tests:**

- `tests/integration/session-rpc.test.ts` - Validates model IDs
- `tests/integration/model-switching.test.ts` - Tests model switching

**E2E Tests:**

- `packages/e2e/tests/model-switcher.e2e.ts` - 27 tests covering:
  - UI interactions
  - Model persistence
  - State synchronization
  - Visual regression

**Manual Testing:**

- `tests/manual/test-model-cache.ts` - Cache behavior verification

## Migration Notes

### Removed Components

1. **Per-session model loading:**
   - Previously: Each session loaded models on creation
   - Now: Global cache loaded once on app startup

2. **Static-first approach:**
   - Previously: Static models used first, dynamic loading optional
   - Now: Dynamic loading on startup, static as fallback only

3. **Synchronous model loading:**
   - Previously: `ensureModelsLoaded()` with race timeout
   - Now: App startup loading with graceful failure

### Benefits

1. **Faster session creation:**
   - No more 2-3 second delay when creating sessions
   - Models pre-loaded and cached

2. **Always up-to-date:**
   - Background refresh keeps models current
   - 4-hour TTL ensures recent model list

3. **Zero user impact:**
   - Lazy refresh is non-blocking
   - Stale cache served instantly

4. **Resilient:**
   - Static fallback for network issues
   - Graceful error handling
   - Automatic retry after TTL

## Configuration

**Cache TTL:**

```typescript
// In model-service.ts
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
```

To change the TTL, modify this constant. Recommended values:

- Development: 1 hour (faster refresh for testing)
- Production: 4 hours (balance between freshness and API calls)
- Enterprise: 24 hours (minimal API usage)

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
[model-service] Will fall back to static models
```

## Future Improvements

1. **Configurable TTL:**
   - Move TTL to config file
   - Allow per-environment configuration

2. **Metrics:**
   - Track cache hit/miss rates
   - Monitor background refresh success rate
   - Alert on repeated failures

3. **Smarter Refresh:**
   - Exponential backoff on failures
   - Header-based cache validation (ETag, Last-Modified)
   - Conditional refresh based on SDK version changes

4. **Admin API:**
   - Manual cache invalidation endpoint
   - Cache stats endpoint
   - Force refresh endpoint
