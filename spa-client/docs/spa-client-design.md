# SPA Client — Design Document
 
**Project:** AG-UI CLI Bridge  
**Component:** `@agui-bridge/client`  
**Version:** 0.1 (draft)  
**Status:** Pre-implementation
 
---
 
## 1. Overview
 
The client is a single-page application (SPA) written in React and TypeScript. It runs in the browser and connects to the bridge server over a WebSocket, consuming and emitting AG-UI protocol events. It is the user-facing surface of the system — the "living document" through which users interact with AI CLI agents running on their local machine.
 
The application is served statically. In development it is served by Vite's dev server. In production it is served by the bridge server itself from a `public/` directory, so the user only needs to start one process.
 
The design goal is not a chat interface. It is a **structured agent workspace**: a session-aware, turn-aware, streaming document with inline tool call approval UI — more akin to a rich terminal than a messaging app.
 
---
 
## 2. Goals and Non-Goals
 
### Goals
 
- Maintain a persistent WebSocket connection to the bridge server with automatic reconnection.
- Render streaming markdown correctly and without flicker during partial syntax (e.g. mid-bold, mid-code-block).
- Present tool call proposals as interactive UI components requiring an explicit user decision (approve / reject / edit args).
- Support multiple concurrent sessions in a tabbed or split-pane layout.
- Reflect session state (idle, streaming, awaiting approval) clearly in the UI at all times.
- Be fully testable without a running server via a mock WebSocket harness.
### Non-Goals
 
- Providing any agent logic, model configuration, or prompt engineering UI in v0.1.
- Authentication or user accounts (localhost trust model, same as the server).
- Mobile layout (desktop viewport only for v0.1).
- Persisting conversation history across browser sessions (the CLI owns history).
---
 
## 3. Package Structure
 
```
packages/client/
├── src/
│   ├── main.tsx                        # React entry point
│   ├── App.tsx                         # Root layout, session tab bar
│   ├── ws/
│   │   ├── WsContext.tsx               # React context: connection + send fn
│   │   ├── useWsConnection.ts          # Hook: manages WebSocket lifecycle
│   │   └── types.ts                    # AG-UI event type definitions (shared with server)
│   ├── store/
│   │   ├── sessionStore.ts             # Zustand store: all session state
│   │   ├── eventReducer.ts             # Pure fn: AG-UI event → state transition
│   │   └── types.ts                    # Store shape types
│   ├── components/
│   │   ├── SessionTabs.tsx             # Tab bar: list sessions, create, switch
│   │   ├── SessionPane.tsx             # One pane per session: message list + input
│   │   ├── MessageList.tsx             # Scrolling list of turns
│   │   ├── MessageBubble.tsx           # One assistant or user turn
│   │   ├── MarkdownRenderer.tsx        # Memoized streaming-safe markdown renderer
│   │   ├── ToolCallCard.tsx            # Tool proposal with approve/reject UI
│   │   ├── ToolCallResult.tsx          # Collapsed result after approval
│   │   ├── PromptInput.tsx             # Textarea + send button
│   │   ├── StatusBar.tsx               # Connection state, session state, provider badge
│   │   └── ErrorBanner.tsx             # CLI_ERROR and connection error display
│   ├── hooks/
│   │   ├── useSession.ts               # Selector hook: one session's state slice
│   │   ├── useAutoScroll.ts            # Scroll-to-bottom on new content
│   │   └── useApprovalTimeout.ts       # Countdown timer for pending tool calls
│   └── lib/
│       ├── markdown.ts                 # marked + highlight.js config
│       ├── idgen.ts                    # Client-side run/message ID generation
│       └── time.ts                     # Timestamp formatting utilities
├── tests/
│   ├── harness/
│   │   ├── mock-server.ts              # Mock WebSocket server for component tests
│   │   └── event-factory.ts            # Factory fns for AG-UI test events
│   ├── unit/
│   │   ├── eventReducer.test.ts
│   │   └── markdown.test.ts
│   └── integration/
│       ├── streaming.test.tsx
│       ├── tool-approval.test.tsx
│       └── reconnection.test.tsx
├── index.html
├── vite.config.ts
├── package.json
└── tsconfig.json
```
 
---
 
## 4. State Model
 
All application state lives in a single Zustand store. The store is the source of truth for what is rendered. WebSocket events mutate the store via the event reducer. User actions (send prompt, approve tool call) produce both a store mutation and a WebSocket send.
 
### 4.1 Store shape
 
```typescript
interface AppStore {
  // Connection
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectionError: string | null;
 
  // Sessions
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
 
  // Actions
  createSession: (provider: Provider, cwd: string) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string) => void;
  approveToolCall: (sessionId: string, toolCallId: string, content: string) => void;
  rejectToolCall: (sessionId: string, toolCallId: string) => void;
}
 
interface SessionState {
  sessionId: string;
  provider: 'claude-code' | 'gemini';
  cwd: string;
  cliVersion: string | null;
  status: SessionStatus;
  turns: Turn[];
  pendingToolCall: PendingToolCall | null;
  error: SessionError | null;
}
 
type SessionStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting_approval'
  | 'error';
 
interface Turn {
  turnId: string;           // runId from RUN_STARTED
  role: 'user' | 'assistant';
  content: string;          // accumulated markdown text
  toolCalls: ToolCallRecord[];
  isStreaming: boolean;     // true until TEXT_MESSAGE_END received
  timestamp: number;
}
 
interface ToolCallRecord {
  toolCallId: string;
  name: string;
  args: string;             // accumulated JSON args string
  status: 'pending' | 'approved' | 'rejected';
  result: string | null;    // content returned after approval
}
 
interface PendingToolCall {
  toolCallId: string;
  name: string;
  args: string;
  parentMessageId: string;
  receivedAt: number;       // for approval timeout countdown
}
 
interface SessionError {
  message: string;
  exitCode: number | null;
  stderr: string | null;
}
```
 
### 4.2 Event reducer
 
The event reducer is a **pure function** that takes the current store state and an incoming AG-UI server event and returns the next state. It has no side effects and is independently unit-testable.
 
```typescript
function applyEvent(state: AppStore, event: ServerEvent): Partial<AppStore>
```
 
All WebSocket message handling flows through this single function. The `useWsConnection` hook calls it on every incoming message via Zustand's `setState`.
 
#### Event → state transition table
 
| Incoming event | State change |
|---|---|
| `SESSION_CREATED` | Add new `SessionState` to `sessions`. Set as `activeSessionId` if none active. |
| `TEXT_MESSAGE_START` | Add new `Turn` with `isStreaming: true` to the active session. |
| `TEXT_MESSAGE_CONTENT` | Append `delta` to the current streaming turn's `content`. |
| `TEXT_MESSAGE_END` | Set current turn's `isStreaming: false`. |
| `TOOL_CALL_START` | Set `pendingToolCall` on session. Set `status: 'awaiting_approval'`. |
| `TOOL_CALL_ARGS` | Append `delta` to `pendingToolCall.args`. |
| `TOOL_CALL_END` | No additional state change (proposal is complete, UI is already shown). |
| `RUN_FINISHED` | Set `status: 'idle'`. Clear `pendingToolCall`. |
| `CLI_ERROR` | Set `status: 'error'`. Set `error` on session. |
| `SESSION_LIST` | Reconcile `sessions` map against received list. |
 
---
 
## 5. WebSocket Layer
 
### 5.1 `useWsConnection`
 
This hook owns the WebSocket instance. It is instantiated once at the application root and its return value is provided via `WsContext`.
 
**Responsibilities:**
 
- Open the WebSocket connection on mount.
- Reconnect automatically with exponential backoff (initial 500ms, max 15s, jitter ±20%).
- Parse incoming JSON messages and dispatch them through the event reducer to the Zustand store.
- Expose a stable `send(event: ClientEvent) => void` function (stable reference across reconnects).
- Track and expose `connectionStatus` to the store.
**Reconnection behavior:**
 
On disconnect, the hook attempts reconnection after a back-off delay. In-flight sessions remain in the store in their last known state. When the connection re-establishes, the hook sends `LIST_SESSIONS` to reconcile server-side session state with the local store. Sessions present locally but absent from the server response are marked with a `stale` flag and shown with a visual indicator.
 
```typescript
interface WsContextValue {
  send: (event: ClientEvent) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
}
```
 
### 5.2 Message framing
 
All messages are UTF-8 JSON strings. One WebSocket message = one AG-UI event object. No batching, no length-prefix framing. The server never sends partial JSON across message boundaries.
 
---
 
## 6. Component Design
 
### 6.1 `App.tsx` — Root layout
 
```
┌─────────────────────────────────────────────────────┐
│  StatusBar  (connection state, active provider)      │
├──────────────────────────────────────────────────────┤
│  SessionTabs  [Session 1 ×] [Session 2 ×] [+]       │
├──────────────────────────────────────────────────────┤
│                                                      │
│  SessionPane (active session)                        │
│  ┌────────────────────────────────────────────────┐  │
│  │  MessageList                                   │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  MessageBubble (user turn)               │  │  │
│  │  ├──────────────────────────────────────────┤  │  │
│  │  │  MessageBubble (assistant turn)          │  │  │
│  │  │  ┌──────────────────────────────────┐   │  │  │
│  │  │  │  MarkdownRenderer (streaming)    │   │  │  │
│  │  │  └──────────────────────────────────┘   │  │  │
│  │  │  ┌──────────────────────────────────┐   │  │  │
│  │  │  │  ToolCallCard (pending approval) │   │  │  │
│  │  │  └──────────────────────────────────┘   │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│  PromptInput  [________________________] [Send]       │
└─────────────────────────────────────────────────────┘
```
 
### 6.2 `MarkdownRenderer`
 
This is the most performance-sensitive component. It renders potentially long markdown strings that are updated on every `TEXT_MESSAGE_CONTENT` event (tens to hundreds of times per second during fast streaming).
 
**Requirements:**
 
- Must not flicker on partial syntax. Bold mid-word (`**he` without closing `**`), unclosed code fences, and partial links must not cause visible layout shifts or disappearing text.
- Must be memoized: only re-render when `content` or `isStreaming` changes.
- Must support syntax highlighting for fenced code blocks.
**Implementation approach:**
 
Use `marked` for markdown parsing with a custom renderer. During streaming (`isStreaming: true`), apply a post-processing step that closes any unclosed markdown constructs before passing the string to the renderer. This prevents the parser from treating `**partial` as a stray `**` and emitting broken HTML.
 
```typescript
interface MarkdownRendererProps {
  content: string;
  isStreaming: boolean;
}
 
const MarkdownRenderer = memo(({ content, isStreaming }: MarkdownRendererProps) => {
  const html = useMemo(() => {
    const safe = isStreaming ? closeOpenConstructs(content) : content;
    return marked.parse(safe);
  }, [content, isStreaming]);
 
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
});
```
 
`closeOpenConstructs` is a lightweight string function (not a full parser) that:
 
1. Counts unmatched `**` and `*` tokens and appends the missing closers.
2. Detects an unclosed code fence (odd number of triple-backtick occurrences) and appends ` ``` `.
3. Detects an unclosed inline code span and appends `` ` ``.
It is tested independently with a comprehensive table of partial markdown inputs and expected outputs.
 
### 6.3 `ToolCallCard`
 
Rendered when `session.pendingToolCall` is non-null and `session.status === 'awaiting_approval'`.
 
```
┌─────────────────────────────────────────────────────┐
│  🔧  Read                          [2:47 remaining] │
├─────────────────────────────────────────────────────┤
│  {                                                  │
│    "file_path": "src/auth.ts"                       │
│  }                                                  │
├─────────────────────────────────────────────────────┤
│  [Edit args ▼]          [Reject]        [Approve →] │
└─────────────────────────────────────────────────────┘
```
 
**Behaviors:**
 
- **Approve:** Calls `approveToolCall(sessionId, toolCallId, args)` with the current (possibly edited) args string. Card transitions to a collapsed `ToolCallResult` display.
- **Reject:** Calls `rejectToolCall(sessionId, toolCallId)`. Card shows a "rejected" badge. Session returns to idle.
- **Edit args:** Expands an inline JSON editor (plain `<textarea>`) pre-filled with the current `args` string. The user can modify the JSON before approving. Validation is done client-side before send — malformed JSON prevents approval and shows an inline error.
- **Timeout countdown:** The `useApprovalTimeout` hook reads `pendingToolCall.receivedAt` and the server's configured timeout (received in `SESSION_CREATED`) to display a live countdown. At zero, the card shows an "expired" state (the server will have already sent `CLI_ERROR`).
### 6.4 `PromptInput`
 
A `<textarea>` with auto-resize and keyboard shortcuts.
 
- `Enter` submits (sends `RUN_STARTED`).
- `Shift+Enter` inserts a newline.
- Disabled (visually and functionally) when `session.status !== 'idle'`.
- Shows a spinner when `status === 'streaming'`.
- Shows a lock icon with "waiting for approval" when `status === 'awaiting_approval'`.
### 6.5 `StatusBar`
 
Displays global connection state and the active session's provider and working directory.
 
| State | Display |
|---|---|
| `connecting` | Amber dot + "Connecting to bridge..." |
| `connected` | Green dot + "Connected" |
| `disconnected` | Red dot + "Disconnected — retrying in 3s" (countdown) |
| `error` | Red dot + error message |
 
Provider badge shows `claude-code` or `gemini` with a distinct color per provider. The working directory is shown as a truncated path (filename + immediate parent only to save space).
 
### 6.6 `ErrorBanner`
 
Shown when `session.error` is non-null. Displays the error message, exit code, and a collapsible stderr block. Includes a "Dismiss" button that clears the error and returns the session to idle.
 
---
 
## 7. Routing
 
The application has no URL-based routing in v0.1. All navigation (switching sessions, creating sessions) is in-app state managed by Zustand. A future version may add URL-based session addressing to support bookmarking or deep-linking to a specific session.
 
---
 
## 8. Styling
 
Styles are written in CSS Modules. No CSS-in-JS runtime. No global utility framework (Tailwind is excluded to avoid build tooling complexity).
 
A small set of CSS custom properties defines the design tokens:
 
```css
:root {
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f5f5f4;
  --color-bg-tertiary: #e8e7e4;
  --color-text-primary: #1a1a18;
  --color-text-secondary: #5f5e5a;
  --color-text-muted: #9c9a92;
  --color-accent-green: #1d9e75;
  --color-accent-purple: #7f77dd;
  --color-accent-amber: #ef9f27;
  --color-accent-red: #e24b4a;
  --color-border: rgba(0, 0, 0, 0.12);
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
}
 
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg-primary: #1a1a18;
    --color-bg-secondary: #242420;
    --color-bg-tertiary: #2c2c2a;
    --color-text-primary: #e8e7e4;
    --color-text-secondary: #9c9a92;
    --color-text-muted: #5f5e5a;
    --color-border: rgba(255, 255, 255, 0.1);
  }
}
```
 
Dark mode is automatic via `prefers-color-scheme`. No manual theme toggle in v0.1.
 
---
 
## 9. Testing Strategy
 
Tests mirror the server-side two-tier approach: unit tests for pure logic, integration tests with a mock WebSocket server for component behavior.
 
### 9.1 Framework and tooling
 
| Tool | Role |
|---|---|
| `vitest` | Test runner |
| `@testing-library/react` | Component rendering and interaction |
| `@testing-library/user-event` | Realistic user input simulation |
| `jsdom` | DOM environment for component tests |
| Mock server (custom) | Scriptable WebSocket server for integration tests |
 
### 9.2 Mock WebSocket server
 
`tests/harness/mock-server.ts` is a lightweight WS server that listens on a random port per test. It exposes methods to:
 
- Queue a sequence of events to emit when a client connects.
- Capture all events sent by the client.
- Simulate connection drops and re-connections.
```typescript
class MockWsServer {
  readonly port: number;
 
  queue(events: ServerEvent[]): void;
  // Events are emitted in order after the client connects
 
  emitNow(event: ServerEvent): void;
  // Emit an event immediately to all connected clients
 
  received(): ClientEvent[];
  // Returns all events received from clients so far
 
  dropConnection(): void;
  // Closes the socket to simulate a network drop
 
  close(): Promise<void>;
}
```
 
### 9.3 Event factory
 
`tests/harness/event-factory.ts` provides typed factory functions for every AG-UI event type, with sensible defaults so tests only specify the fields they care about.
 
```typescript
const Evt = {
  sessionCreated: (overrides?: Partial<SessionCreatedEvent>): SessionCreatedEvent => ({
    type: 'SESSION_CREATED',
    sessionId: 'sess_test',
    provider: 'claude-code',
    cwd: '/tmp/project',
    cliVersion: '2.1.80',
    ...overrides,
  }),
 
  textStart: (overrides?: Partial<TextMessageStartEvent>): TextMessageStartEvent => ({
    type: 'TEXT_MESSAGE_START',
    messageId: 'msg_001',
    role: 'assistant',
    ...overrides,
  }),
 
  textContent: (delta: string, overrides?: Partial<TextMessageContentEvent>) => ({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: 'msg_001',
    delta,
    ...overrides,
  }),
 
  toolCallStart: (overrides?: Partial<ToolCallStartEvent>): ToolCallStartEvent => ({
    type: 'TOOL_CALL_START',
    toolCallId: 'tc_001',
    toolCallName: 'Read',
    parentMessageId: 'msg_001',
    ...overrides,
  }),
 
  runFinished: (overrides?: Partial<RunFinishedEvent>): RunFinishedEvent => ({
    type: 'RUN_FINISHED',
    runId: 'run_001',
    sessionId: 'sess_test',
    stopReason: 'end_turn',
    ...overrides,
  }),
 
  cliError: (overrides?: Partial<CliErrorEvent>): CliErrorEvent => ({
    type: 'CLI_ERROR',
    sessionId: 'sess_test',
    exitCode: 1,
    stderr: 'Error: authentication required.',
    ...overrides,
  }),
};
```
 
### 9.4 Unit tests
 
| Test file | What it covers |
|---|---|
| `eventReducer.test.ts` | Every event type → state transition. Illegal transitions. Concurrent session handling. |
| `markdown.test.ts` | `closeOpenConstructs`: unclosed bold, italic, code fence, inline code, nested constructs. `marked` output for representative content types. |
 
### 9.5 Integration tests
 
Integration tests render the full component tree (or a subtree) with a real Zustand store, connected to a `MockWsServer`.
 
#### `streaming.test.tsx`
 
```typescript
it('renders streaming text incrementally without layout shifts', async () => {
  const server = new MockWsServer();
  server.queue([
    Evt.sessionCreated(),
    Evt.textStart(),
    Evt.textContent('Here is a '),
    Evt.textContent('**partial'),   // unclosed bold mid-stream
    Evt.textContent(' bold**'),     // now closed
    Evt.textContent(' response.'),
    { type: 'TEXT_MESSAGE_END', messageId: 'msg_001' },
    Evt.runFinished(),
  ]);
 
  render(<App wsPort={server.port} />);
 
  await waitFor(() =>
    expect(screen.getByText(/Here is a/)).toBeInTheDocument()
  );
 
  // Mid-stream: partial bold should not produce stray ** characters in the DOM
  await waitFor(() => {
    const content = screen.getByTestId('message-content-msg_001').textContent;
    expect(content).not.toContain('**');
  });
 
  // Final: bold rendered correctly
  await waitFor(() =>
    expect(screen.getByRole('strong')).toHaveTextContent('partial bold')
  );
 
  await server.close();
});
```
 
#### `tool-approval.test.tsx`
 
```typescript
it('shows ToolCallCard on proposal and sends TOOL_CALL_RESULT on approval', async () => {
  const server = new MockWsServer();
  server.queue([
    Evt.sessionCreated(),
    Evt.textStart(),
    Evt.textContent("I'll read the file."),
    { type: 'TEXT_MESSAGE_END', messageId: 'msg_001' },
    Evt.toolCallStart(),
    { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_001', delta: '{"file_path":"src/auth.ts"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'tc_001' },
  ]);
 
  render(<App wsPort={server.port} />);
 
  // Tool call card appears
  const card = await screen.findByTestId('tool-call-card-tc_001');
  expect(card).toHaveTextContent('Read');
  expect(card).toHaveTextContent('src/auth.ts');
 
  // Prompt input is locked
  expect(screen.getByTestId('prompt-input')).toBeDisabled();
 
  // User clicks approve
  await userEvent.click(screen.getByRole('button', { name: /approve/i }));
 
  // Client sent TOOL_CALL_RESULT
  await waitFor(() => {
    const sent = server.received();
    const result = sent.find(e => e.type === 'TOOL_CALL_RESULT');
    expect(result).toBeDefined();
    expect(result.approved).toBe(true);
    expect(result.toolCallId).toBe('tc_001');
  });
 
  await server.close();
});
```
 
#### `reconnection.test.tsx`
 
```typescript
it('reconnects and reconciles session state after connection drop', async () => {
  const server = new MockWsServer();
  server.queue([Evt.sessionCreated()]);
 
  render(<App wsPort={server.port} />);
  await screen.findByTestId('session-tab-sess_test');
 
  // Drop the connection
  server.dropConnection();
 
  // Status bar shows disconnected
  await waitFor(() =>
    expect(screen.getByTestId('connection-status')).toHaveTextContent(/disconnected/i)
  );
 
  // Server comes back; client reconnects and sends LIST_SESSIONS
  server.queue([{ type: 'SESSION_LIST', sessions: [{ sessionId: 'sess_test', status: 'idle' }] }]);
 
  await waitFor(() =>
    expect(screen.getByTestId('connection-status')).toHaveTextContent(/connected/i)
  );
 
  const sent = server.received();
  expect(sent.some(e => e.type === 'LIST_SESSIONS')).toBe(true);
 
  await server.close();
});
```
 
### 9.6 Running tests
 
```bash
# All tests
pnpm test
 
# Unit only
pnpm test:unit
 
# Integration only
pnpm test:integration
 
# Watch mode
pnpm test --watch
 
# Coverage
pnpm test --coverage
```
 
---
 
## 10. Build and Development
 
### Development
 
```bash
pnpm dev
```
 
Starts Vite dev server on port `5173`. The Vite config proxies WebSocket connections on `/ws` to `ws://localhost:7878` so the browser client connects to the local bridge server without CORS issues and without changing any URLs.
 
```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:7878',
        ws: true,
      },
    },
  },
});
```
 
### Production build
 
```bash
pnpm build
```
 
Outputs to `dist/`. The bridge server's npm package includes a postinstall step that copies this `dist/` directory to its own `public/` folder, so `npx @agui-bridge/server` serves the SPA automatically.
 
---
 
## 11. Dependencies
 
| Package | Purpose |
|---|---|
| `react` + `react-dom` | UI framework |
| `zustand` | Client state management |
| `ws` | WebSocket (mock server in tests only) |
| `marked` | Markdown parsing |
| `highlight.js` | Syntax highlighting inside code blocks |
| `vite` | Build tool and dev server (dev dependency) |
| `vitest` | Test runner (dev dependency) |
| `@testing-library/react` | Component test utilities (dev dependency) |
| `@testing-library/user-event` | User interaction simulation (dev dependency) |
| `typescript` | Language (dev dependency) |
 
---
 
## 12. Open Questions
 
1. **Shared event types package.** The AG-UI event type definitions (`ServerEvent`, `ClientEvent` unions and all subtypes) need to be shared between the server and client packages without duplication. The options are: (a) a third `@agui-bridge/protocol` package that both depend on, or (b) co-locating types in the server package and having the client depend on it at build time. Option (a) is cleaner for long-term maintenance. Decision needed before either package defines its own types.
2. **Split-pane vs tabbed session layout.** The current design specifies tabs. A split-pane layout (two sessions side by side) may be more useful for comparing providers on the same task. This is a layout decision that does not affect the state model or protocol, but does affect the component tree meaningfully. Defer to v0.2 or decide before implementing `SessionTabs`.
3. **Tool arg editing UX.** The "Edit args" expansion in `ToolCallCard` uses a plain `<textarea>`. A proper JSON editor (e.g. `monaco-editor` in minimal mode) would give syntax highlighting, validation, and bracket matching. The weight of monaco (~2MB) may not be justified for v0.1. Confirm appetite for the dependency before implementation.
4. **`closeOpenConstructs` completeness.** The streaming markdown fix for partial syntax is a heuristic, not a full parser. There are edge cases (nested emphasis, link titles with backticks, etc.) that it will not handle correctly. The decision is whether to invest in a more robust solution (e.g. a streaming markdown parser that emits safe HTML incrementally) or accept the heuristic and document its known gaps.
5. **Approval timeout source of truth.** The server config includes an `approvalTimeoutMs` value. The client needs this value to drive the `useApprovalTimeout` countdown. Currently the plan is to include it in the `SESSION_CREATED` event payload. This should be confirmed with the server design before implementation.
