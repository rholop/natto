import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import type { CliAdapter } from '../adapters/adapter.js';
import { FanoutEmitter, type EventSink } from '../protocol/emitter.js';
import type {
  AssistantMessage,
  CliErrorEvent,
  LogEntry,
  Message,
  MessageUpdate,
  Provider,
  SessionSnapshotEvent,
  SessionState,
  ToolCallMessage,
  ToolResultSummary,
  UserMessage,
} from '../protocol/events.js';
import { JsonlLineBuffer, type CliEvent } from '../protocol/parser.js';
import { applyPatch } from '../protocol/reducer.js';
import {
  openSessionLog,
  readToolResultSidecar,
  writeMeta,
  writeToolResultSidecar,
  type SessionLog,
  type SessionMeta,
} from './store.js';

export interface PendingApproval {
  toolCallId: string;
  respond: (decision: { allow: boolean; reason?: string }) => void;
}

export interface SessionOptions {
  meta: SessionMeta;
  stateDir: string;
  adapter: CliAdapter;
  log: SessionLog;
  initialMessages?: Message[];
  historyPageSize: number;
  toolOutputPreviewBytes: number;
  hookBaseUrl: string;
  hookToken: string;
  logger?: (msg: string) => void;
}

type Logger = (msg: string) => void;

interface ActiveTurn {
  child: ChildProcessByStdio<null, Readable, Readable>;
  buffer: JsonlLineBuffer;
  stderr: string;
  assistantMessageId: string | null;
  pendingToolCall: {
    toolCallId: string;
    messageId: string;
    name: string;
    args: string;
    resultBuffer: string;
  } | null;
  finished: boolean;
}

export class Session {
  readonly sessionId: string;
  readonly provider: Provider;
  readonly cwd: string;

  private meta: SessionMeta;
  private readonly stateDir: string;
  private readonly adapter: CliAdapter;
  private readonly log: SessionLog;
  private readonly historyPageSize: number;
  private readonly toolOutputPreviewBytes: number;
  private readonly hookBaseUrl: string;
  private readonly hookToken: string;
  private readonly logger: Logger;

  private readonly fanout = new FanoutEmitter();
  private readonly messages: Message[] = [];
  private readonly messagesById = new Map<string, Message>();

  private turn: ActiveTurn | null = null;
  private pendingApproval: PendingApproval | null = null;
  private lastActivityAt: number;

  constructor(opts: SessionOptions) {
    this.meta = opts.meta;
    this.sessionId = opts.meta.sessionId;
    this.provider = opts.meta.provider;
    this.cwd = opts.meta.cwd;
    this.stateDir = opts.stateDir;
    this.adapter = opts.adapter;
    this.log = opts.log;
    this.historyPageSize = opts.historyPageSize;
    this.toolOutputPreviewBytes = opts.toolOutputPreviewBytes;
    this.hookBaseUrl = opts.hookBaseUrl;
    this.hookToken = opts.hookToken;
    this.logger = opts.logger ?? (() => {});

    if (opts.initialMessages) {
      for (const m of opts.initialMessages) {
        this.messages.push(m);
        this.messagesById.set(m.messageId, m);
      }
    }
    this.lastActivityAt = Date.now();
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getState(): SessionState {
    return this.meta.state;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  subscriberCount(): number {
    return this.fanout.size();
  }

  attach(sink: EventSink): SessionSnapshotEvent {
    this.fanout.add(sink);
    this.lastActivityAt = Date.now();
    const { entries, hasMore } = this.log.tail(this.historyPageSize);
    const inFlight = this.currentInFlightMessage();
    const pending = this.pendingToolCallSummary();
    return {
      type: 'SESSION_SNAPSHOT',
      seq: this.meta.lastSeq,
      sessionId: this.sessionId,
      state: this.meta.state,
      lastSeq: this.meta.lastSeq,
      recent: entries,
      inFlight,
      pendingToolCall: pending,
      hasMore,
    };
  }

  detach(sink: EventSink): void {
    this.fanout.remove(sink);
    this.lastActivityAt = Date.now();
  }

  fetchHistory(beforeSeq: number, limit?: number): { entries: LogEntry[]; hasMore: boolean } {
    const effective = Math.max(1, limit ?? this.historyPageSize);
    return this.log.readBefore(beforeSeq, effective);
  }

  async fetchToolResult(toolCallId: string): Promise<string | null> {
    return readToolResultSidecar(this.stateDir, this.sessionId, toolCallId);
  }

  get hookToken_readonly(): string {
    return this.hookToken;
  }

  startTurn(prompt: string): void {
    if (this.meta.state !== 'Idle') {
      this.emitError('session_busy', `Cannot start turn in state ${this.meta.state}`);
      return;
    }
    const now = Date.now();
    const userMsg: UserMessage = {
      messageId: uuidv4(),
      role: 'user',
      content: prompt,
      at: now,
      status: 'complete',
    };
    this.emitMessage(userMsg);
    this.spawnCli(prompt);
  }

  submitToolResult(decision: { toolCallId: string; approved: boolean; reason?: string }): void {
    if (this.meta.state !== 'AwaitingApproval' || !this.pendingApproval) {
      this.logger(`ignored TOOL_CALL_RESULT: state=${this.meta.state}`);
      return;
    }
    if (decision.toolCallId !== this.pendingApproval.toolCallId) {
      this.logger(`ignored TOOL_CALL_RESULT: unknown toolCallId=${decision.toolCallId}`);
      return;
    }
    const pending = this.pendingApproval;
    this.pendingApproval = null;
    this.transition('Streaming');
    const update: MessageUpdate = {
      messageId: this.findToolCallMessageId(decision.toolCallId) ?? decision.toolCallId,
      approval: decision.approved ? 'approved' : 'denied',
      denialReason: decision.approved ? undefined : decision.reason,
    };
    this.emitUpdate(update);
    pending.respond({ allow: decision.approved, reason: decision.reason });
  }

  abortTurn(reason = 'aborted'): void {
    if (this.turn) {
      try {
        this.turn.child.kill('SIGTERM');
      } catch {
        // already exited
      }
    }
    if (this.pendingApproval) {
      this.pendingApproval.respond({ allow: false, reason: 'aborted' });
      this.pendingApproval = null;
    }
    this.closeInFlight('interrupted');
    this.turn = null;
    if (this.meta.state !== 'Idle') {
      this.logger(`session ${this.sessionId} aborted: ${reason}`);
      this.transition('Idle');
    }
  }

  handlePermissionHook(
    toolCallId: string,
    name: string,
    args: string,
    respond: (decision: { allow: boolean; reason?: string }) => void,
  ): void {
    if (!this.turn) {
      respond({ allow: false, reason: 'no_active_turn' });
      return;
    }
    const messageId = uuidv4();
    const toolCallMessage: ToolCallMessage = {
      messageId,
      role: 'tool_call',
      toolCallId,
      name,
      args,
      approval: 'pending',
      result: null,
      at: Date.now(),
      status: 'in_progress',
    };
    this.turn.pendingToolCall = {
      toolCallId,
      messageId,
      name,
      args,
      resultBuffer: '',
    };
    this.emitMessage(toolCallMessage);
    this.pendingApproval = { toolCallId, respond };
    this.transition('AwaitingApproval');
  }

  private spawnCli(prompt: string): void {
    const { argv, env } = this.adapter.buildSpawn({
      prompt,
      cwd: this.cwd,
      resumeUuid: this.meta.cliSessionUuid,
      hookUrl: `${this.hookBaseUrl}/hook/permission-prompt`,
      hookToken: this.hookToken,
      sessionId: this.sessionId,
    });
    const [bin, ...args] = argv;
    if (!bin) {
      this.emitError('adapter_error', 'adapter returned empty argv');
      return;
    }
    this.transition('Spawning');
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        cwd: this.cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emitError('spawn_failed', (err as Error).message);
      this.transition('Idle');
      return;
    }
    const turn: ActiveTurn = {
      child,
      buffer: new JsonlLineBuffer(),
      stderr: '',
      assistantMessageId: null,
      pendingToolCall: null,
      finished: false,
    };
    this.turn = turn;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      turn.stderr += chunk;
    });
    child.on('error', (err) => {
      this.emitError('spawn_error', err.message);
    });
    child.on('close', (code) => this.onExit(code ?? 0));
    this.transition('Streaming');
  }

  private onStdout(chunk: string): void {
    if (!this.turn) return;
    for (const line of this.turn.buffer.feed(chunk)) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!this.turn) return;
    const event = this.adapter.parseJsonlLine(line);
    if (!event) {
      this.logger(`skipped malformed/unknown line: ${line}`);
      return;
    }
    this.applyCliEvent(event);
  }

  private applyCliEvent(event: CliEvent): void {
    if (!this.turn) return;
    switch (event.type) {
      case 'session_id':
        this.meta = { ...this.meta, cliSessionUuid: event.uuid };
        this.persistMeta();
        break;

      case 'text_delta': {
        if (!this.turn.assistantMessageId) {
          const messageId = uuidv4();
          this.turn.assistantMessageId = messageId;
          const msg: AssistantMessage = {
            messageId,
            role: 'assistant',
            content: '',
            at: Date.now(),
            status: 'in_progress',
          };
          this.emitMessage(msg);
        }
        this.emitUpdate({
          messageId: this.turn.assistantMessageId,
          contentDelta: event.delta,
        });
        break;
      }

      case 'tool_call':
        // For adapters that report tool calls on the JSONL stream (rather than
        // solely via the permission-prompt hook), treat the line as informational —
        // the hook is the source of truth for pending approvals.
        this.logger(`tool_call line seen on stdout (via adapter parse): ${event.name}`);
        break;

      case 'tool_result': {
        const pending = this.turn.pendingToolCall;
        if (!pending || pending.toolCallId !== event.toolCallId) {
          this.logger(`tool_result for unknown toolCallId=${event.toolCallId}`);
          return;
        }
        pending.resultBuffer += event.content;
        break;
      }

      case 'end_turn':
        this.turn.finished = true;
        if (this.turn.assistantMessageId) {
          this.emitUpdate({
            messageId: this.turn.assistantMessageId,
            status: 'complete',
          });
          this.turn.assistantMessageId = null;
        }
        break;

      case 'error':
        this.emitError('cli_error_event', event.message);
        break;
    }
  }

  private onExit(code: number): void {
    const turn = this.turn;
    if (!turn) return;
    for (const line of turn.buffer.flush()) this.handleLine(line);

    if (turn.pendingToolCall) {
      const pending = turn.pendingToolCall;
      const summary = this.summarizeToolResult(pending.toolCallId, pending.resultBuffer);
      this.emitUpdate({
        messageId: pending.messageId,
        result: summary,
        status: 'complete',
      });
      turn.pendingToolCall = null;
    }

    if (turn.assistantMessageId) {
      this.emitUpdate({
        messageId: turn.assistantMessageId,
        status: turn.finished ? 'complete' : 'interrupted',
      });
      turn.assistantMessageId = null;
    }

    if (code !== 0 && !turn.finished) {
      this.emitError(
        'cli_exit_nonzero',
        `CLI exited with code ${code}`,
        { exitCode: code, stderr: turn.stderr },
      );
    }

    this.turn = null;
    this.pendingApproval = null;
    this.transition('Idle');
  }

  private summarizeToolResult(toolCallId: string, content: string): ToolResultSummary {
    const totalBytes = Buffer.byteLength(content, 'utf8');
    const limit = this.toolOutputPreviewBytes;
    if (totalBytes <= limit) {
      return { preview: content, totalBytes, truncated: false };
    }
    const preview = content.slice(0, limit);
    const sidecarPath = writeToolResultSidecar(
      this.stateDir,
      this.sessionId,
      toolCallId,
      content,
    );
    return { preview, totalBytes, truncated: true, sidecarPath };
  }

  private emitMessage(message: Message): void {
    this.messages.push(message);
    this.messagesById.set(message.messageId, message);
    const seq = this.nextSeq();
    const event = { type: 'MESSAGE' as const, seq, sessionId: this.sessionId, message };
    this.log.append(event);
    this.persistMeta();
    this.fanout.broadcast(event);
    this.lastActivityAt = Date.now();
  }

  private emitUpdate(update: MessageUpdate): void {
    const current = this.messagesById.get(update.messageId);
    if (current) {
      const next = applyPatch(current, update);
      this.messagesById.set(next.messageId, next);
      const idx = this.messages.findIndex((m) => m.messageId === next.messageId);
      if (idx >= 0) this.messages[idx] = next;
    }
    const seq = this.nextSeq();
    const event = { type: 'MESSAGE_UPDATE' as const, seq, sessionId: this.sessionId, update };
    this.log.append(event);
    this.persistMeta();
    this.fanout.broadcast(event);
    this.lastActivityAt = Date.now();
  }

  private emitError(
    reason: string,
    message: string,
    extras: { exitCode?: number; stderr?: string } = {},
  ): void {
    const event: CliErrorEvent = {
      type: 'CLI_ERROR',
      seq: this.meta.lastSeq,
      sessionId: this.sessionId,
      reason,
      message,
      ...extras,
    };
    this.fanout.broadcast(event);
    this.lastActivityAt = Date.now();
  }

  private nextSeq(): number {
    this.meta = { ...this.meta, lastSeq: this.meta.lastSeq + 1, updatedAt: Date.now() };
    return this.meta.lastSeq;
  }

  private transition(next: SessionState): void {
    if (this.meta.state === next) return;
    this.logger(`session ${this.sessionId}: ${this.meta.state} → ${next}`);
    this.meta = { ...this.meta, state: next, updatedAt: Date.now() };
    this.persistMeta();
  }

  private persistMeta(): void {
    writeMeta(this.stateDir, this.meta);
  }

  private currentInFlightMessage(): Message | null {
    if (!this.turn) return null;
    const id = this.turn.assistantMessageId;
    if (!id) return null;
    return this.messagesById.get(id) ?? null;
  }

  private pendingToolCallSummary():
    | { toolCallId: string; messageId: string; name: string; args: string }
    | null {
    if (!this.pendingApproval || !this.turn?.pendingToolCall) return null;
    const p = this.turn.pendingToolCall;
    return {
      toolCallId: p.toolCallId,
      messageId: p.messageId,
      name: p.name,
      args: p.args,
    };
  }

  private findToolCallMessageId(toolCallId: string): string | null {
    for (const m of this.messages) {
      if (m.role === 'tool_call' && m.toolCallId === toolCallId) return m.messageId;
    }
    return null;
  }

  private closeInFlight(status: 'interrupted' | 'complete'): void {
    if (this.turn?.assistantMessageId) {
      this.emitUpdate({ messageId: this.turn.assistantMessageId, status });
      this.turn.assistantMessageId = null;
    }
    if (this.turn?.pendingToolCall) {
      this.emitUpdate({
        messageId: this.turn.pendingToolCall.messageId,
        status,
      });
      this.turn.pendingToolCall = null;
    }
  }
}
