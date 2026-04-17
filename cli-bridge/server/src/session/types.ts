import type { Provider, SessionRecord } from '../protocol/events.js';

export enum SessionState {
  Idle = 'Idle',
  Spawning = 'Spawning',
  Streaming = 'Streaming',
  AwaitingApproval = 'AwaitingApproval',
  InjectingResult = 'InjectingResult',
  Done = 'Done',
}

export interface SessionInfo {
  sessionId: string;
  provider: Provider;
  cwd: string;
  state: SessionState;
  createdAt: number;
}

export function toSessionRecord(info: SessionInfo): SessionRecord {
  return {
    sessionId: info.sessionId,
    provider: info.provider,
    cwd: info.cwd,
    state: info.state,
    createdAt: info.createdAt,
  };
}
