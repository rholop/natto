import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
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
  provider: Provider;
  cwd: string;
  cliSessionUuid: string | null;
  state: SessionState;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

const SessionMetaSchema = z.object({
  provider: z.enum(PROVIDERS),
  cwd: z.string(),
  cliSessionUuid: z.string().nullable(),
  state: z.enum(SESSION_STATES),
  lastSeq: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

function metaPath(stateDir: string): string {
  return join(stateDir, 'meta.json');
}
function logPath(stateDir: string): string {
  return join(stateDir, 'log.jsonl');
}
function resultsDir(stateDir: string): string {
  return join(stateDir, 'results');
}
function sidecarPath(stateDir: string, toolCallId: string): string {
  return join(resultsDir(stateDir), `${toolCallId}.txt`);
}

export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(resultsDir(stateDir), { recursive: true });
}

export function writeMeta(stateDir: string, meta: SessionMeta): void {
  ensureStateDir(stateDir);
  const path = metaPath(stateDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function readMeta(stateDir: string): SessionMeta | null {
  const path = metaPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = SessionMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface SessionLog {
  append(entry: LogEntry): void;
  readAll(): LogEntry[];
  tail(limit: number): { entries: LogEntry[]; hasMore: boolean };
  readBefore(beforeSeq: number, limit: number): { entries: LogEntry[]; hasMore: boolean };
  close(): void;
}

export function openSessionLog(stateDir: string): SessionLog {
  ensureStateDir(stateDir);
  const path = logPath(stateDir);
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
  toolCallId: string,
  content: string,
): string {
  ensureStateDir(stateDir);
  const path = sidecarPath(stateDir, toolCallId);
  writeFileSync(path, content, 'utf8');
  return path;
}

export async function readToolResultSidecar(
  stateDir: string,
  toolCallId: string,
): Promise<string | null> {
  const path = sidecarPath(stateDir, toolCallId);
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

export function sidecarPathFor(stateDir: string, toolCallId: string): string {
  return sidecarPath(stateDir, toolCallId);
}

export function logFilePath(stateDir: string): string {
  return logPath(stateDir);
}

export function metaFilePath(stateDir: string): string {
  return metaPath(stateDir);
}
