import { v4 as uuidv4 } from 'uuid';
import type { CliAdapter } from '../adapters/adapter.js';
import type { EventSink } from '../protocol/emitter.js';
import type { Provider } from '../protocol/events.js';
import { Session } from './session.js';
import { toSessionRecord, type SessionInfo } from './types.js';

export interface RegistryOptions {
  maxSessions: number;
  approvalTimeoutMs: number;
  adapterFor: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
}

export interface CreateSessionArgs {
  provider: Provider;
  cwd: string;
  emitter: EventSink;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: RegistryOptions) {}

  create(args: CreateSessionArgs): Session {
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(`max sessions (${this.opts.maxSessions}) reached`);
    }
    const sessionId = uuidv4();
    const adapter = this.opts.adapterFor(args.provider);
    const session = new Session({
      sessionId,
      provider: args.provider,
      cwd: args.cwd,
      adapter,
      emitter: args.emitter,
      approvalTimeoutMs: this.opts.approvalTimeoutMs,
      logger: this.opts.logger,
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  listRecords() {
    return this.list().map(toSessionRecord);
  }

  remove(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.abort('removed');
    this.sessions.delete(sessionId);
    return true;
  }

  size(): number {
    return this.sessions.size;
  }

  clear(): void {
    for (const s of this.sessions.values()) s.abort('registry_clear');
    this.sessions.clear();
  }
}
