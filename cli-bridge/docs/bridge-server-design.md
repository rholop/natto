# Bridge Server — Design Document

**Project:** AG-UI CLI Bridge
**Component:** `@agui-bridge/server`
**Version:** 0.1 (draft)
**Status:** Pre-implementation

---

## 1. Overview

The bridge server is a standalone local npm package written in TypeScript. It runs on the user's desktop and serves as the translation layer between browser-based clients (communicating via the AG-UI protocol over WebSockets) and AI CLI tools (Claude Code, Gemini CLI) spawned as child processes.

The server exposes a single WebSocket endpoint. Clients connect to it to create sessions, send prompts, approve or reject tool calls, and receive streaming responses. Each session corresponds to one logical conversation with one CLI provider.

The server has no cloud dependencies. It inherits CLI authentication from the user's local environment (existing OAuth credentials, API keys in shell profile, etc.) and never handles credentials directly.

---

## 2. Goals and Non-Goals

### Goals

- Provide a stable, typed WebSocket interface conforming to the AG-UI protocol.
- Support Claude Code and Gemini CLI as interchangeable providers via a common adapter interface.
- Handle the full human-in-the-loop tool approval cycle: pause execution, surface the proposal to the client, resume on approval, abort cleanly on rejection.
- Be installable as a global npm package (`npm install -g @agui-bridge/server`) and launchable with a single CLI command.
- Be fully testable without a real CLI installed, via a mock CLI harness.

### Non-Goals

- Multi-user or network-accessible deployments (localhost only, no auth layer in v0.1).
- Persistent storage of conversation history (the CLI's own session store owns that).
- Providing a web UI (that is the responsibility of the separate client package).
- Support for remote or cloud-hosted CLI processes.

---

## 3. Architecture

### 3.1 Package structure

In this repo the server lives under `cli-bridge/server/` (the design uses the name `packages/server/` generically — the monorepo root is `cli-bridge/`).

```
cli-bridge/server/
├── src/
│   ├── index.ts                  # Entry point, starts WS server
│   ├── server.ts                 # WebSocket server, connection lifecycle
│   ├── session/
│   │   ├── registry.ts           # SessionRegistry: create/get/list/remove sessions
│   │   ├── session.ts            # Session: per-connection state machine
│   │   └── types.ts              # SessionState enum, SessionRecord interface
│   ├── adapters/
│   │   ├── adapter.ts            # CliAdapter interface
│   │   ├── claude-code.ts        # ClaudeCodeAdapter implementation
│   │   └── gemini.ts             # GeminiAdapter implementation
│   ├── protocol/
│   │   ├── events.ts             # AG-UI event type definitions + custom extensions
│   │   ├── parser.ts             # JSONL stream parser (stdout → AG-UI events)
│   │   └── emitter.ts            # Typed WebSocket event emitter
│   └── config.ts                 # Port, timeouts, provider defaults
├── tests/
│   ├── harness/
│   │   ├── mock-cli.ts           # Mock CLI process (scriptable JSONL emitter)
│   │   ├── ws-client.ts          # Test WebSocket client
│   │   └── scenario.ts           # Scenario builder DSL
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── registry.test.ts
│   │   └── session.test.ts
│   └── integration/
│       ├── streaming.test.ts
│       ├── tool-approval.test.ts
│       └── error-handling.test.ts
├── package.json
└── tsconfig.json
```

### 3.2 Layers

See the full design doc in the PR description / issue; layered diagram preserved below.

```
WebSocket clients (browser)
        │  AG-UI events (JSON)
        ▼
┌─────────────────────────────┐
│  server.ts                  │  WebSocket server (ws library)
│  - Connection lifecycle     │  One WS connection per client
│  - Event routing            │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│  SessionRegistry            │  Owns all active sessions
│  - create / get / remove    │  Keyed by sessionId (UUID v4)
└────────────┬────────────────┘
             │  one per session
┌────────────▼────────────────┐
│  Session (state machine)    │  Manages turn lifecycle
│  - Idle → Spawning          │
│  - → Streaming              │
│  - → AwaitingApproval       │
│  - → InjectingResult        │
│  - → Done → Idle            │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│  CliAdapter (interface)     │  Abstracts provider differences
│  ClaudeCodeAdapter          │  Builds claude -p ... argv
│  GeminiAdapter              │  Builds gemini ... argv
└────────────┬────────────────┘
             │  child_process.spawn
             ▼
        CLI process (stdout JSONL)
```

---

## 4. Session State Machine

See design §4 in the canonical document. States: `Idle`, `Spawning`, `Streaming`, `AwaitingApproval`, `InjectingResult`, `Done`.

## 5. CLI Adapter Interface

```typescript
interface CliAdapter {
  readonly provider: 'claude-code' | 'gemini';
  buildArgv(opts: SpawnOptions): string[];
  parseJsonlLine(raw: string): CliEvent | null;
  buildResumePrompt(toolResult: ToolCallResult): string;
}
```

## 6. AG-UI Protocol

Server-sent events: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `RUN_FINISHED`, plus custom extensions `SESSION_CREATED`, `SESSION_LIST`, `CLI_ERROR`.

Client-sent events: `RUN_STARTED`, `TOOL_CALL_RESULT`, plus custom extensions `CREATE_SESSION`, `LIST_SESSIONS`, `REMOVE_SESSION`.

## 7. WebSocket Server

Default: `127.0.0.1:7878`, approval timeout 5min, max 10 sessions.

## 8. Testing Strategy

Vitest, `ws` in tests, a scriptable mock CLI that reads scenarios from `MOCK_CLI_SCENARIO`, and a fluent `Scenario` builder. See `tests/` for concrete patterns.

## 9. Error Handling

- CLI non-zero exit → `CLI_ERROR` with exitCode + stderr, session returns to `Idle`.
- Approval timeout → `CLI_ERROR` with `reason: 'approval_timeout'`.
- Malformed JSONL → logged and skipped.
- Unknown client event → logged and ignored.
- `RUN_STARTED` on a busy session → `CLI_ERROR` with `reason: 'session_busy'`.

## 10. Dependencies

Runtime: `ws`, `uuid`, `zod`. Dev: `typescript`, `tsx`, `vitest`.

## 11. Open Questions

1. Gemini `--resume` equivalent (blocks real-Gemini verification of `GeminiAdapter`).
2. Gemini `stream-json` event schema (same).
3. Concurrent sessions per WebSocket connection (current: registry-scoped, multi-session).
4. Approval timeout UX (currently surfaced via `CLI_ERROR`; could warrant a dedicated event).
5. `--dangerously-skip-permissions` exposure (not supported in v0.1).
