import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import type { CliAdapter, ToolCallResult } from '../adapters/adapter.js';
import type { EventSink } from '../protocol/emitter.js';
import type { Provider, ServerEvent } from '../protocol/events.js';
import { JsonlLineBuffer } from '../protocol/parser.js';
import { SessionState, type SessionInfo } from './types.js';

export interface SessionOptions {
  sessionId: string;
  provider: Provider;
  cwd: string;
  adapter: CliAdapter;
  emitter: EventSink;
  approvalTimeoutMs: number;
  logger?: (msg: string) => void;
}

interface ActiveTurn {
  runId: string;
  messageId: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  buffer: JsonlLineBuffer;
  stderr: string;
  textStarted: boolean;
  pendingToolCall: { toolCallId: string; toolName: string } | null;
  initialPrompt: string;
  resumePromptPending: string | null;
  approvalTimer: NodeJS.Timeout | null;
  lastToolResult: ToolCallResult | null;
  // When true, an exit was caused by tool-call pause — not a real finish.
  pausedForTool: boolean;
  finished: boolean;
}

export class Session {
  readonly sessionId: string;
  readonly provider: Provider;
  readonly cwd: string;
  private state: SessionState = SessionState.Idle;
  private readonly adapter: CliAdapter;
  private readonly emitter: EventSink;
  private readonly approvalTimeoutMs: number;
  private readonly logger: (msg: string) => void;
  private readonly createdAt = Date.now();

  private cliSessionUuid: string | null = null;
  private turn: ActiveTurn | null = null;
  // Holds a tool result that arrived before the CLI fully exited. Applied in
  // onExit once we transition into AwaitingApproval.
  private pendingEarlyResult: { toolCallId: string; approved: boolean; content?: string } | null = null;

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.provider = opts.provider;
    this.cwd = opts.cwd;
    this.adapter = opts.adapter;
    this.emitter = opts.emitter;
    this.approvalTimeoutMs = opts.approvalTimeoutMs;
    this.logger = opts.logger ?? (() => {});
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      provider: this.provider,
      cwd: this.cwd,
      state: this.state,
      createdAt: this.createdAt,
    };
  }

  getState(): SessionState {
    return this.state;
  }

  startTurn(runId: string, prompt: string): void {
    if (this.state !== SessionState.Idle) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId,
        reason: 'session_busy',
        message: `Session is ${this.state}, cannot start a new turn.`,
      });
      return;
    }
    this.spawnCli(runId, prompt);
  }

  submitToolResult(toolCallId: string, approved: boolean, content?: string): void {
    // If a tool_call was already announced but the CLI child hasn't exited yet
    // (we're still in Streaming), buffer the decision and apply it on exit.
    if (
      this.state === SessionState.Streaming &&
      this.turn?.pendingToolCall?.toolCallId === toolCallId
    ) {
      this.pendingEarlyResult = { toolCallId, approved, content };
      return;
    }
    if (this.state !== SessionState.AwaitingApproval || !this.turn) {
      this.logger(`ignored TOOL_CALL_RESULT: state=${this.state}`);
      return;
    }
    const pending = this.turn.pendingToolCall;
    if (!pending || pending.toolCallId !== toolCallId) {
      this.logger(`ignored TOOL_CALL_RESULT: unknown toolCallId=${toolCallId}`);
      return;
    }
    if (this.turn.approvalTimer) {
      clearTimeout(this.turn.approvalTimer);
      this.turn.approvalTimer = null;
    }
    const result: ToolCallResult = {
      toolCallId,
      toolName: pending.toolName,
      approved,
      content,
    };
    this.turn.lastToolResult = result;
    const resumePrompt = this.adapter.buildResumePrompt(result);
    this.turn.resumePromptPending = resumePrompt;
    this.transition(SessionState.InjectingResult);
    this.respawnWithResume(this.turn.runId, resumePrompt);
  }

  abort(reason = 'aborted'): void {
    if (this.turn) {
      if (this.turn.approvalTimer) clearTimeout(this.turn.approvalTimer);
      try {
        this.turn.child.kill('SIGTERM');
      } catch {
        // already exited
      }
      this.turn = null;
    }
    if (this.state !== SessionState.Idle) {
      this.logger(`session aborted from state=${this.state} reason=${reason}`);
      this.transition(SessionState.Idle);
    }
  }

  private spawnCli(runId: string, prompt: string): void {
    const messageId = uuidv4();
    const argv = this.adapter.buildArgv({
      sessionUuid: this.cliSessionUuid,
      prompt,
      cwd: this.cwd,
    });
    const [bin, ...args] = argv;
    if (!bin) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId,
        reason: 'adapter_error',
        message: 'adapter returned empty argv',
      });
      return;
    }
    this.transition(SessionState.Spawning);

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId,
        reason: 'spawn_failed',
        message: (err as Error).message,
      });
      this.transition(SessionState.Idle);
      return;
    }

    this.turn = {
      runId,
      messageId,
      child,
      buffer: new JsonlLineBuffer(),
      stderr: '',
      textStarted: false,
      pendingToolCall: null,
      initialPrompt: prompt,
      resumePromptPending: null,
      approvalTimer: null,
      lastToolResult: null,
      pausedForTool: false,
      finished: false,
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.turn) this.turn.stderr += chunk;
    });
    child.on('error', (err) => {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId: this.turn?.runId,
        reason: 'spawn_error',
        message: err.message,
      });
    });
    child.on('close', (code) => this.onExit(code ?? 0));

    this.transition(SessionState.Streaming);
  }

  private respawnWithResume(runId: string, prompt: string): void {
    const messageId = uuidv4();
    const argv = this.adapter.buildArgv({
      sessionUuid: this.cliSessionUuid,
      prompt,
      cwd: this.cwd,
    });
    const [bin, ...args] = argv;
    if (!bin) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId,
        reason: 'adapter_error',
        message: 'adapter returned empty argv on resume',
      });
      this.transition(SessionState.Idle);
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId,
        reason: 'spawn_failed',
        message: (err as Error).message,
      });
      this.transition(SessionState.Idle);
      return;
    }

    this.turn = {
      runId,
      messageId,
      child,
      buffer: new JsonlLineBuffer(),
      stderr: '',
      textStarted: false,
      pendingToolCall: null,
      initialPrompt: prompt,
      resumePromptPending: null,
      approvalTimer: null,
      lastToolResult: null,
      pausedForTool: false,
      finished: false,
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.turn) this.turn.stderr += chunk;
    });
    child.on('error', (err) => {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId: this.turn?.runId,
        reason: 'spawn_error',
        message: err.message,
      });
    });
    child.on('close', (code) => this.onExit(code ?? 0));

    this.transition(SessionState.Streaming);
  }

  private onStdout(chunk: string): void {
    if (!this.turn) return;
    const lines = this.turn.buffer.feed(chunk);
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!this.turn) return;
    const event = this.adapter.parseJsonlLine(line);
    if (!event) {
      this.logger(`skipped malformed or unknown line: ${line}`);
      return;
    }
    switch (event.type) {
      case 'session_id':
        this.cliSessionUuid = event.uuid;
        break;

      case 'text_delta':
        if (!this.turn.textStarted) {
          this.turn.textStarted = true;
          this.emit({
            type: 'TEXT_MESSAGE_START',
            messageId: this.turn.messageId,
            role: 'assistant',
            sessionId: this.sessionId,
            runId: this.turn.runId,
          });
        }
        this.emit({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: this.turn.messageId,
          delta: event.delta,
          sessionId: this.sessionId,
          runId: this.turn.runId,
        });
        break;

      case 'tool_call': {
        if (this.turn.textStarted) {
          this.emit({
            type: 'TEXT_MESSAGE_END',
            messageId: this.turn.messageId,
            sessionId: this.sessionId,
            runId: this.turn.runId,
          });
          this.turn.textStarted = false;
        }
        const toolCallId = event.id ?? uuidv4();
        this.turn.pendingToolCall = { toolCallId, toolName: event.name };
        this.turn.pausedForTool = true;
        this.emit({
          type: 'TOOL_CALL_START',
          toolCallId,
          toolCallName: event.name,
          parentMessageId: this.turn.messageId,
          sessionId: this.sessionId,
          runId: this.turn.runId,
        });
        if (event.args.length > 0) {
          this.emit({
            type: 'TOOL_CALL_ARGS',
            toolCallId,
            delta: event.args,
            sessionId: this.sessionId,
            runId: this.turn.runId,
          });
        }
        this.emit({
          type: 'TOOL_CALL_END',
          toolCallId,
          sessionId: this.sessionId,
          runId: this.turn.runId,
        });
        break;
      }

      case 'end_turn':
        this.turn.finished = true;
        if (this.turn.textStarted) {
          this.emit({
            type: 'TEXT_MESSAGE_END',
            messageId: this.turn.messageId,
            sessionId: this.sessionId,
            runId: this.turn.runId,
          });
          this.turn.textStarted = false;
        }
        this.emit({
          type: 'RUN_FINISHED',
          runId: this.turn.runId,
          sessionId: this.sessionId,
          stopReason: event.stopReason,
        });
        break;

      case 'error':
        this.emit({
          type: 'CLI_ERROR',
          sessionId: this.sessionId,
          runId: this.turn.runId,
          reason: 'cli_error_event',
          message: event.message,
        });
        break;
    }
  }

  private onExit(code: number): void {
    const turn = this.turn;
    if (!turn) return;
    // Drain any remaining buffered line.
    for (const line of turn.buffer.flush()) this.handleLine(line);

    if (turn.pausedForTool && turn.pendingToolCall) {
      // Tool call proposed; wait for approval. Keep turn around so we can resume.
      this.transition(SessionState.AwaitingApproval);
      turn.approvalTimer = setTimeout(() => this.onApprovalTimeout(), this.approvalTimeoutMs);
      // If the client already sent TOOL_CALL_RESULT before the child exited,
      // apply it now.
      if (this.pendingEarlyResult && this.pendingEarlyResult.toolCallId === turn.pendingToolCall.toolCallId) {
        const early = this.pendingEarlyResult;
        this.pendingEarlyResult = null;
        this.submitToolResult(early.toolCallId, early.approved, early.content);
      }
      return;
    }

    if (code !== 0 && !turn.finished) {
      this.emit({
        type: 'CLI_ERROR',
        sessionId: this.sessionId,
        runId: turn.runId,
        exitCode: code,
        stderr: turn.stderr,
        reason: 'cli_exit_nonzero',
        message: `CLI exited with code ${code}`,
      });
    }

    this.turn = null;
    this.transition(code === 0 && turn.finished ? SessionState.Done : SessionState.Idle);
    if (this.state === SessionState.Done) this.transition(SessionState.Idle);
  }

  private onApprovalTimeout(): void {
    const turn = this.turn;
    if (!turn) return;
    this.emit({
      type: 'CLI_ERROR',
      sessionId: this.sessionId,
      runId: turn.runId,
      reason: 'approval_timeout',
      message: 'Approval timed out while awaiting user decision.',
    });
    this.turn = null;
    this.transition(SessionState.Idle);
  }

  private emit(event: ServerEvent): void {
    this.emitter.emit(event);
  }

  private transition(next: SessionState): void {
    if (this.state === next) return;
    this.logger(`session ${this.sessionId}: ${this.state} → ${next}`);
    this.state = next;
  }
}
