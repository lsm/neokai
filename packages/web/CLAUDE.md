# Web Package

Frontend UI built with Preact, Preact Signals, Vite, and Tailwind CSS.

## Architecture

### Component layers

- **Islands** (`src/islands/`) — Full-page interactive components (ChatContainer, Room, SessionList, Lobby, etc.)
- **Components** (`src/components/`) — Reusable pieces organized by domain:
  - `ui/` — Primitives (Button, Modal, Dropdown, Tooltip, Collapsible)
  - `chat/` — Chat message rendering and input
  - `room/` — Room dashboard, goals, tasks, task view
  - `settings/` — Settings panels
  - `sdk/` — SDK message rendering and tool display
  - `icons/` — Icon components

### State management

- **Preact Signals** for global reactive state (`src/lib/signals.ts`)
- **StateChannel** pattern (`src/lib/state-channel.ts`) for session/room data with subscription-based updates
- **Stores** (`sessionStore`, `globalStore`, `roomStore`, `lobbyStore`) as reactive wrappers over state channels
- Signal naming convention: `*Signal` suffix (e.g., `currentSessionIdSignal`)

### Communication

- All daemon communication goes through `useMessageHub` hook — never direct API calls
- RPC helpers in `src/lib/api-helpers.ts` for type-safe calls
- Subscription-based state sync (not polling)

## Key patterns

- **JSX runtime**: Preact automatic (not React) — import from `preact` not `react`
- **Styling**: Tailwind CSS + design tokens in `src/lib/design-tokens.ts`, class merging with `cn()`
- **Hooks**: Custom hooks in `src/hooks/` handle domain logic (messaging, sessions, UI state)
- **Props**: Interface pattern `ComponentNameProps`
- **Variants**: Union types for component variants (e.g., `ButtonVariant = 'primary' | 'secondary'`)

## Testing

```bash
bunx vitest run src/some-test.test.ts    # Single test
make test:web                             # All tests with coverage
```

Tests use Vitest, colocated in `__tests__/` directories adjacent to source.
