# WebSocket Protocol

Transport: single WebSocket per session, UTF-8 JSON frames. Each frame is an object discriminated by `type`. Server frames carry a monotonic `seq` (per session, starts at 1); paged/fetched responses use `seq: 0` and correlate via `requestId`. Authoritative schema: [`cli-bridge/server/src/protocol/events.ts`](../server/src/protocol/events.ts).

## Shared types

- `SessionState` = `"Idle" | "Spawning" | "Streaming" | "AwaitingApproval" | "Done"`
- `ToolResultSummary` = `{ preview: string, totalBytes: number, truncated: boolean, sidecarPath?: string }`
- `Message` (discriminated on `role`):
  - **user**: `{ role: "user", messageId, content: string, at: number, status: "complete" }`
  - **assistant**: `{ role: "assistant", messageId, content: string, at: number, status: "in_progress"|"complete"|"interrupted" }`
  - **tool_call**: `{ role: "tool_call", messageId, toolCallId, name, args: string, approval: "pending"|"approved"|"denied", result: ToolResultSummary|null, at, status: "in_progress"|"complete"|"interrupted" }`

## Server → Browser

### `MESSAGE`
Emit a newly created message (user prompt, assistant turn, or tool call).
Fields: `type`, `seq: number`, `message: Message`.
`{"type":"MESSAGE","seq":2,"message":{"role":"assistant","messageId":"m2","content":"","at":1700000000000,"status":"in_progress"}}`

### `MESSAGE_UPDATE`
Patch an existing message (append text, set approval, attach result, change status, revise tool args).
Fields: `type`, `seq`, `update: { messageId, contentDelta?: string, approval?: "approved"|"denied", denialReason?: string, result?: ToolResultSummary, status?: "in_progress"|"complete"|"interrupted", args?: string }`.
`{"type":"MESSAGE_UPDATE","seq":3,"update":{"messageId":"m2","contentDelta":"Hello"}}`

### `SNAPSHOT`
Sent once on connect to bootstrap the client with current session state and recent log.
Fields: `type`, `seq`, `state: SessionState`, `lastSeq: number`, `recent: LogEntry[]`, `inFlight: Message|null`, `pendingToolCall: { toolCallId, messageId, name, args }|null`, `hasMore: boolean`.
`{"type":"SNAPSHOT","seq":5,"state":"Streaming","lastSeq":5,"recent":[],"inFlight":null,"pendingToolCall":null,"hasMore":false}`

### `HISTORY_PAGE`
Reply to `FETCH_HISTORY` with an older page of `MESSAGE`/`MESSAGE_UPDATE` entries.
Fields: `type`, `seq: 0`, `requestId: string`, `entries: LogEntry[]`, `hasMore: boolean`.
`{"type":"HISTORY_PAGE","seq":0,"requestId":"r1","entries":[],"hasMore":false}`

### `TOOL_RESULT_CONTENT`
Reply to `TOOL_RESULT_FETCH` with the full body of a truncated tool result.
Fields: `type`, `seq: 0`, `requestId`, `toolCallId`, `content: string`.
`{"type":"TOOL_RESULT_CONTENT","seq":0,"requestId":"r2","toolCallId":"tc1","content":"...full output..."}`

### `CLI_ERROR`
Report a CLI/process/protocol error (e.g. `cli_exit_nonzero`, `invalid_message`, `adapter_error`, `session_busy`, `spawn_error`, `spawn_failed`).
Fields: `type`, `seq`, `reason: string`, `message: string`, `exitCode?: number`, `stderr?: string`.
`{"type":"CLI_ERROR","seq":7,"reason":"cli_exit_nonzero","message":"CLI exited with code 1","exitCode":1}`

## Browser → Server

### `START_TURN`
Begin a new turn by spawning the CLI with `prompt`. Allowed only in `Idle`.
Fields: `type`, `prompt: string`.
`{"type":"START_TURN","prompt":"summarize README"}`

### `TOOL_CALL_RESULT`
Approve or deny a pending tool call. Allowed only in `AwaitingApproval`.
Fields: `type`, `toolCallId: string`, `approved: boolean`, `reason?: string`.
`{"type":"TOOL_CALL_RESULT","toolCallId":"tc1","approved":false,"reason":"would overwrite file"}`

### `FETCH_HISTORY`
Request a page of log entries strictly older than `beforeSeq`.
Fields: `type`, `beforeSeq: number`, `limit?: number`, `requestId: string`.
`{"type":"FETCH_HISTORY","beforeSeq":42,"limit":20,"requestId":"r1"}`

### `TOOL_RESULT_FETCH`
Request the full body for a tool result whose summary was truncated.
Fields: `type`, `toolCallId: string`, `requestId: string`.
`{"type":"TOOL_RESULT_FETCH","toolCallId":"tc1","requestId":"r2"}`

### `ABORT_TURN`
Kill the running CLI and return the session to `Idle`.
Fields: `type`.
`{"type":"ABORT_TURN"}`
