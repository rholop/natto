import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  LogEntrySchema,
  PROVIDERS,
  SESSION_STATES,
  type LogEntry,
  type Provider,
  type SessionState,
} from '../protocol/events.js';

export interface SessionMeta {
  sessionId: string;
  provider: Provider;
  cwd: string;
  cliSessionUuid: string | null;
  state: SessionState;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

const SessionMetaSchema = z.object({
  sessionId: z.string(),
  provider: z.enum(PROVIDERS),
  cwd: z.string(),
  cliSessionUuid: z.string().nullable(),
  state: z.enum(SESSION_STATES),
  lastSeq: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export function sessionsDir(stateDir: string): string {
  return join(stateDir, 'sessions');
}
export function sessionDir(stateDir: string, sessionId: string): string {
  return join(sessionsDir(stateDir), sessionId);
}
function metaPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), 'meta.json');
}
function logPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), 'log.jsonl');
}
function resultsDir(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), 'results');
}
function sidecarPath(stateDir: string, sessionId: string, toolCallId: string): string {
  return join(resultsDir(stateDir, sessionId), `${toolCallId}.txt`);
}

export function ensureSessionDir(stateDir: string, sessionId: string): void {
  mkdirSync(sessionDir(stateDir, sessionId), { recursive: true });
  mkdirSync(resultsDir(stateDir, sessionId), { recursive: true });
}

export function writeMeta(stateDir: string, meta: SessionMeta): void {
  ensureSessionDir(stateDir, meta.sessionId);
  const path = metaPath(stateDir, meta.sessionId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function readMeta(stateDir: string, sessionId: string): SessionMeta | null {
  const path = metaPath(stateDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = SessionMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function listSessionDirs(stateDir: string): string[] {
  const root = sessionsDir(stateDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function removeSessionDir(stateDir: string, sessionId: string): void {
  const dir = sessionDir(stateDir, sessionId);
  if (!existsSync(dir)) return;
  rmrf(dir);
}

function rmrf(path: string): void {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) rmrf(join(path, entry));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { rmdirSync } = require('node:fs') as typeof import('node:fs');
      rmdirSync(path);
    } catch {
      // ignore
    }
  } else {
    unlinkSync(path);
  }
}

export interface SessionLog {
  append(entry: LogEntry): void;
  readAll(): LogEntry[];
  tail(limit: number): { entries: LogEntry[]; hasMore: boolean };
  readBefore(beforeSeq: number, limit: number): { entries: LogEntry[]; hasMore: boolean };
  close(): void;
}

export function openSessionLog(stateDir: string, sessionId: string): SessionLog {
  ensureSessionDir(stateDir, sessionId);
  const path = logPath(stateDir, sessionId);
  const fd = openSync(path, 'a');

  function readEntries(): LogEntry[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: LogEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = LogEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  return {
    append(entry) {
      writeSync(fd, JSON.stringify(entry) + '\n');
    },
    readAll() {
      return readEntries();
    },
    tail(limit) {
      const all = readEntries();
      if (limit <= 0) return { entries: [], hasMore: all.length > 0 };
      const start = Math.max(0, all.length - limit);
      return { entries: all.slice(start), hasMore: start > 0 };
    },
    readBefore(beforeSeq, limit) {
      const all = readEntries();
      const before = all.filter((e) => e.seq < beforeSeq);
      if (limit <= 0) return { entries: [], hasMore: before.length > 0 };
      const start = Math.max(0, before.length - limit);
      return { entries: before.slice(start), hasMore: start > 0 };
    },
    close() {
      try {
        closeSync(fd);
      } catch {
        // ignore double close
      }
    },
  };
}

export function writeToolResultSidecar(
  stateDir: string,
  sessionId: string,
  toolCallId: string,
  content: string,
): string {
  ensureSessionDir(stateDir, sessionId);
  const path = sidecarPath(stateDir, sessionId, toolCallId);
  writeFileSync(path, content, 'utf8');
  return path;
}

export async function readToolResultSidecar(
  stateDir: string,
  sessionId: string,
  toolCallId: string,
): Promise<string | null> {
  const path = sidecarPath(stateDir, sessionId, toolCallId);
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
}

export interface LockHandle {
  release(): void;
  path: string;
}

export class LockHeldError extends Error {
  constructor(
    public readonly path: string,
    public readonly holderPid: number,
  ) {
    super(`bridge.lock is held by pid ${holderPid} at ${path}`);
    this.name = 'LockHeldError';
  }
}

export function acquireLock(stateDir: string): LockHandle {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'bridge.lock');
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    const pid = Number(existing);
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
      throw new LockHeldError(path, pid);
    }
    // stale — remove and re-acquire
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
  writeFileSync(path, String(process.pid), 'utf8');
  return {
    path,
    release() {
      try {
        const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
        if (raw === String(process.pid)) unlinkSync(path);
      } catch {
        // ignore
      }
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionsDir(stateDir), { recursive: true });
}

export function sidecarPathFor(
  stateDir: string,
  sessionId: string,
  toolCallId: string,
): string {
  return sidecarPath(stateDir, sessionId, toolCallId);
}

export function logFilePath(stateDir: string, sessionId: string): string {
  return logPath(stateDir, sessionId);
}

export function metaFilePath(stateDir: string, sessionId: string): string {
  return metaPath(stateDir, sessionId);
}
