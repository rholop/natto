import { randomBytes } from 'node:crypto';
import type { CliAdapter } from '../adapters/adapter.js';
import { type Message, type Provider } from '../protocol/events.js';
import { applyPatch } from '../protocol/reducer.js';
import { Session } from './session.js';
import {
  ensureStateDir,
  openSessionLog,
  readMeta,
  writeMeta,
  type SessionMeta,
} from './store.js';

export interface HolderOptions {
  stateDir: string;
  provider: Provider;
  cwd: string;
  historyPageSize: number;
  toolOutputPreviewBytes: number;
  hookBaseUrl: string;
  adapterFor: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
  resumeUuid?: string | null;
}

export class ProviderMismatchError extends Error {
  constructor(
    public readonly expected: Provider,
    public readonly found: Provider,
  ) {
    super(`stateDir holds a ${found} session but bridge was started with --provider ${expected}`);
    this.name = 'ProviderMismatchError';
  }
}

export class SessionHolder {
  private session: Session | null = null;
  private hookBaseUrl: string;
  private hookToken: string;

  constructor(private readonly opts: HolderOptions) {
    ensureStateDir(opts.stateDir);
    this.hookBaseUrl = opts.hookBaseUrl;
    this.hookToken = randomBytes(24).toString('hex');
  }

  setHookBaseUrl(url: string): void {
    this.hookBaseUrl = url;
    if (this.session) this.session.setHookBaseUrl(url);
  }

  /**
   * Load the session from disk, creating a fresh one if none exists.
   * Errors if the on-disk provider doesn't match opts.provider.
   */
  load(): Session {
    const existing = readMeta(this.opts.stateDir);
    if (existing) {
      if (existing.provider !== this.opts.provider) {
        throw new ProviderMismatchError(this.opts.provider, existing.provider);
      }
      this.session = this.hydrateExisting(existing);
    } else {
      this.session = this.createFresh();
    }
    return this.session;
  }

  get(): Session {
    if (!this.session) throw new Error('SessionHolder: load() must be called first');
    return this.session;
  }

  resolveHookToken(token: string): Session | undefined {
    if (token !== this.hookToken) return undefined;
    return this.session ?? undefined;
  }

  async shutdown(): Promise<void> {
    if (this.session) this.session.abortTurn('bridge_shutdown');
    this.session = null;
  }

  private createFresh(): Session {
    const now = Date.now();
    const resumeUuid = this.opts.resumeUuid ?? null;
    const meta: SessionMeta = {
      provider: this.opts.provider,
      cwd: this.opts.cwd,
      cliSessionUuid: resumeUuid,
      state: 'Idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(this.opts.stateDir, meta);
    const adapter = this.opts.adapterFor(this.opts.provider);
    const log = openSessionLog(this.opts.stateDir);
    return new Session({
      meta,
      stateDir: this.opts.stateDir,
      adapter,
      log,
      historyPageSize: this.opts.historyPageSize,
      toolOutputPreviewBytes: this.opts.toolOutputPreviewBytes,
      hookBaseUrl: this.hookBaseUrl,
      hookToken: this.hookToken,
      logger: this.opts.logger,
    });
  }

  private hydrateExisting(existing: SessionMeta): Session {
    const log = openSessionLog(this.opts.stateDir);
    const rawEntries = log.readAll();
    const { messages, openAssistantId, openToolCallId } = projectMessages(rawEntries);

    const lastSeq = rawEntries.length > 0 ? rawEntries[rawEntries.length - 1]!.seq : existing.lastSeq;
    const resumeUuid = this.opts.resumeUuid ?? existing.cliSessionUuid;
    let restoredMeta: SessionMeta = {
      ...existing,
      cliSessionUuid: resumeUuid,
      state: 'Idle',
      lastSeq,
      updatedAt: Date.now(),
    };

    if (openAssistantId || openToolCallId) {
      let seq = restoredMeta.lastSeq;
      if (openAssistantId) {
        seq += 1;
        log.append({
          type: 'MESSAGE_UPDATE',
          seq,
          update: { messageId: openAssistantId, status: 'interrupted' },
        });
      }
      if (openToolCallId) {
        seq += 1;
        log.append({
          type: 'MESSAGE_UPDATE',
          seq,
          update: { messageId: openToolCallId, status: 'interrupted' },
        });
      }
      restoredMeta = { ...restoredMeta, lastSeq: seq };
    }
    writeMeta(this.opts.stateDir, restoredMeta);

    const adapter = this.opts.adapterFor(restoredMeta.provider);
    return new Session({
      meta: restoredMeta,
      stateDir: this.opts.stateDir,
      adapter,
      log,
      initialMessages: messages,
      historyPageSize: this.opts.historyPageSize,
      toolOutputPreviewBytes: this.opts.toolOutputPreviewBytes,
      hookBaseUrl: this.hookBaseUrl,
      hookToken: this.hookToken,
      logger: this.opts.logger,
    });
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
