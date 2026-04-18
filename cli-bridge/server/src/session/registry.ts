import { randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { CliAdapter } from '../adapters/adapter.js';
import {
  type Message,
  type Provider,
  type SessionInfo,
} from '../protocol/events.js';
import { applyPatch } from '../protocol/reducer.js';
import { Session } from './session.js';
import {
  ensureStateDir,
  listSessionDirs,
  openSessionLog,
  readMeta,
  removeSessionDir,
  writeMeta,
  type SessionMeta,
} from './store.js';

export interface RegistryOptions {
  stateDir: string;
  maxSessions: number;
  historyPageSize: number;
  toolOutputPreviewBytes: number;
  orphanTtlMs: number;
  hookBaseUrl: string;
  adapterFor: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly hookTokens = new Map<string, string>();
  private hookBaseUrl: string;

  constructor(private readonly opts: RegistryOptions) {
    ensureStateDir(opts.stateDir);
    this.hookBaseUrl = opts.hookBaseUrl;
  }

  setHookBaseUrl(url: string): void {
    this.hookBaseUrl = url;
  }

  create(args: { provider: Provider; cwd: string }): Session {
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(`max sessions (${this.opts.maxSessions}) reached`);
    }
    const now = Date.now();
    const sessionId = uuidv4();
    const meta: SessionMeta = {
      sessionId,
      provider: args.provider,
      cwd: args.cwd,
      cliSessionUuid: null,
      state: 'Idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(this.opts.stateDir, meta);
    const adapter = this.opts.adapterFor(args.provider);
    const log = openSessionLog(this.opts.stateDir, sessionId);
    const hookToken = randomBytes(24).toString('hex');
    const session = new Session({
      meta,
      stateDir: this.opts.stateDir,
      adapter,
      log,
      historyPageSize: this.opts.historyPageSize,
      toolOutputPreviewBytes: this.opts.toolOutputPreviewBytes,
      hookBaseUrl: this.hookBaseUrl,
      hookToken,
      logger: this.opts.logger,
    });
    this.sessions.set(sessionId, session);
    this.hookTokens.set(hookToken, sessionId);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  resolveHookToken(token: string): Session | undefined {
    const sessionId = this.hookTokens.get(token);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => {
      const m = s.getMeta();
      return {
        sessionId: m.sessionId,
        provider: m.provider,
        cwd: m.cwd,
        state: m.state,
        lastSeq: m.lastSeq,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      };
    });
  }

  remove(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.abortTurn('removed');
    this.sessions.delete(sessionId);
    for (const [token, id] of this.hookTokens) {
      if (id === sessionId) this.hookTokens.delete(token);
    }
    removeSessionDir(this.opts.stateDir, sessionId);
    return true;
  }

  size(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) s.abortTurn('registry_shutdown');
    this.sessions.clear();
    this.hookTokens.clear();
  }

  sweepOrphans(now = Date.now()): number {
    let evicted = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.subscriberCount() > 0) continue;
      if (s.getState() !== 'Idle') continue;
      if (now - s.getLastActivityAt() < this.opts.orphanTtlMs) continue;
      this.remove(s.sessionId);
      evicted++;
    }
    return evicted;
  }

  hydrateFromDisk(): number {
    const ids = listSessionDirs(this.opts.stateDir);
    let loaded = 0;
    for (const id of ids) {
      if (this.sessions.has(id)) continue;
      const meta = readMeta(this.opts.stateDir, id);
      if (!meta) continue;
      const log = openSessionLog(this.opts.stateDir, id);
      const rawEntries = log.readAll();
      const { messages, openAssistantId, openToolCallId } = projectMessages(rawEntries);

      const needsInterrupt = openAssistantId || openToolCallId;
      const restoredMeta: SessionMeta = {
        ...meta,
        state: 'Idle',
        lastSeq: rawEntries.length > 0 ? rawEntries[rawEntries.length - 1]!.seq : meta.lastSeq,
        updatedAt: Date.now(),
      };
      if (needsInterrupt) {
        let seq = restoredMeta.lastSeq;
        if (openAssistantId) {
          seq += 1;
          log.append({
            type: 'MESSAGE_UPDATE',
            seq,
            sessionId: id,
            update: { messageId: openAssistantId, status: 'interrupted' },
          });
        }
        if (openToolCallId) {
          seq += 1;
          log.append({
            type: 'MESSAGE_UPDATE',
            seq,
            sessionId: id,
            update: { messageId: openToolCallId, status: 'interrupted' },
          });
        }
        restoredMeta.lastSeq = seq;
      }
      writeMeta(this.opts.stateDir, restoredMeta);

      const adapter = this.opts.adapterFor(restoredMeta.provider);
      const hookToken = randomBytes(24).toString('hex');
      const session = new Session({
        meta: restoredMeta,
        stateDir: this.opts.stateDir,
        adapter,
        log,
        initialMessages: messages,
        historyPageSize: this.opts.historyPageSize,
        toolOutputPreviewBytes: this.opts.toolOutputPreviewBytes,
        hookBaseUrl: this.hookBaseUrl,
        hookToken,
        logger: this.opts.logger,
      });
      this.sessions.set(id, session);
      this.hookTokens.set(hookToken, id);
      loaded++;
    }
    return loaded;
  }
}

function projectMessages(entries: ReturnType<ReturnType<typeof openSessionLog>['readAll']>): {
  messages: Message[];
  openAssistantId: string | null;
  openToolCallId: string | null;
} {
  const byId = new Map<string, Message>();
  const order: string[] = [];
  let openAssistantId: string | null = null;
  let openToolCallId: string | null = null;
  for (const entry of entries) {
    if (entry.type === 'MESSAGE') {
      byId.set(entry.message.messageId, entry.message);
      order.push(entry.message.messageId);
      if (entry.message.role === 'assistant' && entry.message.status === 'in_progress') {
        openAssistantId = entry.message.messageId;
      }
      if (entry.message.role === 'tool_call' && entry.message.status === 'in_progress') {
        openToolCallId = entry.message.messageId;
      }
    } else {
      const current = byId.get(entry.update.messageId);
      if (!current) continue;
      const next = applyPatch(current, entry.update);
      byId.set(next.messageId, next);
      if (entry.update.status === 'complete' || entry.update.status === 'interrupted') {
        if (openAssistantId === entry.update.messageId) openAssistantId = null;
        if (openToolCallId === entry.update.messageId) openToolCallId = null;
      }
    }
  }
  const messages: Message[] = order.map((id) => byId.get(id)!).filter(Boolean);
  return { messages, openAssistantId, openToolCallId };
}
