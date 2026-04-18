import { z } from 'zod';

export const PROVIDERS = ['claude-code', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];
const ProviderSchema = z.enum(PROVIDERS);

export const SESSION_STATES = [
  'Idle',
  'Spawning',
  'Streaming',
  'AwaitingApproval',
  'Done',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];
const SessionStateSchema = z.enum(SESSION_STATES);

const ToolResultSummarySchema = z.object({
  preview: z.string(),
  totalBytes: z.number(),
  truncated: z.boolean(),
  sidecarPath: z.string().optional(),
});
export type ToolResultSummary = z.infer<typeof ToolResultSummarySchema>;

const UserMessageSchema = z.object({
  messageId: z.string(),
  role: z.literal('user'),
  content: z.string(),
  at: z.number(),
  status: z.literal('complete'),
});
const AssistantMessageSchema = z.object({
  messageId: z.string(),
  role: z.literal('assistant'),
  content: z.string(),
  at: z.number(),
  status: z.enum(['in_progress', 'complete', 'interrupted']),
});
const ToolCallMessageSchema = z.object({
  messageId: z.string(),
  role: z.literal('tool_call'),
  toolCallId: z.string(),
  name: z.string(),
  args: z.string(),
  approval: z.enum(['pending', 'approved', 'denied']),
  result: ToolResultSummarySchema.nullable(),
  at: z.number(),
  status: z.enum(['in_progress', 'complete', 'interrupted']),
});

export const MessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolCallMessageSchema,
]);
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;

export const MessageUpdateSchema = z.object({
  messageId: z.string(),
  contentDelta: z.string().optional(),
  approval: z.enum(['approved', 'denied']).optional(),
  denialReason: z.string().optional(),
  result: ToolResultSummarySchema.optional(),
  status: z.enum(['in_progress', 'complete', 'interrupted']).optional(),
  args: z.string().optional(),
});
export type MessageUpdate = z.infer<typeof MessageUpdateSchema>;

const MessageEventSchema = z.object({
  type: z.literal('MESSAGE'),
  seq: z.number(),
  sessionId: z.string(),
  message: MessageSchema,
});
const MessageUpdateEventSchema = z.object({
  type: z.literal('MESSAGE_UPDATE'),
  seq: z.number(),
  sessionId: z.string(),
  update: MessageUpdateSchema,
});
export const LogEntrySchema = z.union([MessageEventSchema, MessageUpdateEventSchema]);
export type LogEntry = z.infer<typeof LogEntrySchema>;

const SessionCreatedSchema = z.object({
  type: z.literal('SESSION_CREATED'),
  seq: z.number(),
  sessionId: z.string(),
  provider: ProviderSchema,
  cwd: z.string(),
});

const SessionInfoSchema = z.object({
  sessionId: z.string(),
  provider: ProviderSchema,
  cwd: z.string(),
  state: SessionStateSchema,
  lastSeq: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

const SessionListSchema = z.object({
  type: z.literal('SESSION_LIST'),
  seq: z.number(),
  sessionId: z.string(),
  sessions: z.array(SessionInfoSchema),
});

const SessionAttachedSchema = z.object({
  type: z.literal('SESSION_ATTACHED'),
  seq: z.number(),
  sessionId: z.string(),
  lastSeq: z.number(),
});

const PendingToolCallSchema = z.object({
  toolCallId: z.string(),
  messageId: z.string(),
  name: z.string(),
  args: z.string(),
});

const SessionSnapshotSchema = z.object({
  type: z.literal('SESSION_SNAPSHOT'),
  seq: z.number(),
  sessionId: z.string(),
  state: SessionStateSchema,
  lastSeq: z.number(),
  recent: z.array(LogEntrySchema),
  inFlight: MessageSchema.nullable(),
  pendingToolCall: PendingToolCallSchema.nullable(),
  hasMore: z.boolean(),
});

const SessionRemovedSchema = z.object({
  type: z.literal('SESSION_REMOVED'),
  seq: z.number(),
  sessionId: z.string(),
});

const HistoryPageSchema = z.object({
  type: z.literal('HISTORY_PAGE'),
  seq: z.number(),
  sessionId: z.string(),
  requestId: z.string(),
  entries: z.array(LogEntrySchema),
  hasMore: z.boolean(),
});

const ToolResultContentSchema = z.object({
  type: z.literal('TOOL_RESULT_CONTENT'),
  seq: z.number(),
  sessionId: z.string(),
  requestId: z.string(),
  toolCallId: z.string(),
  content: z.string(),
});

const CliErrorSchema = z.object({
  type: z.literal('CLI_ERROR'),
  seq: z.number(),
  sessionId: z.string(),
  reason: z.string(),
  message: z.string(),
  exitCode: z.number().optional(),
  stderr: z.string().optional(),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  MessageEventSchema,
  MessageUpdateEventSchema,
  SessionCreatedSchema,
  SessionListSchema,
  SessionAttachedSchema,
  SessionSnapshotSchema,
  SessionRemovedSchema,
  HistoryPageSchema,
  ToolResultContentSchema,
  CliErrorSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type MessageUpdateEvent = z.infer<typeof MessageUpdateEventSchema>;
export type SessionSnapshotEvent = z.infer<typeof SessionSnapshotSchema>;
export type SessionListEvent = z.infer<typeof SessionListSchema>;
export type HistoryPageEvent = z.infer<typeof HistoryPageSchema>;
export type ToolResultContentEvent = z.infer<typeof ToolResultContentSchema>;
export type CliErrorEvent = z.infer<typeof CliErrorSchema>;

const CreateSessionSchema = z.object({
  type: z.literal('CREATE_SESSION'),
  provider: ProviderSchema,
  cwd: z.string(),
});
const ListSessionsSchema = z.object({ type: z.literal('LIST_SESSIONS') });
const AttachSessionSchema = z.object({
  type: z.literal('ATTACH_SESSION'),
  sessionId: z.string(),
});
const DetachSessionSchema = z.object({
  type: z.literal('DETACH_SESSION'),
  sessionId: z.string(),
});
const RemoveSessionSchema = z.object({
  type: z.literal('REMOVE_SESSION'),
  sessionId: z.string(),
});
const StartTurnSchema = z.object({
  type: z.literal('START_TURN'),
  sessionId: z.string(),
  prompt: z.string(),
});
const ToolCallResultSchema = z.object({
  type: z.literal('TOOL_CALL_RESULT'),
  sessionId: z.string(),
  toolCallId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});
const FetchHistorySchema = z.object({
  type: z.literal('FETCH_HISTORY'),
  sessionId: z.string(),
  beforeSeq: z.number(),
  limit: z.number().optional(),
  requestId: z.string(),
});
const ToolResultFetchSchema = z.object({
  type: z.literal('TOOL_RESULT_FETCH'),
  sessionId: z.string(),
  toolCallId: z.string(),
  requestId: z.string(),
});
const AbortTurnSchema = z.object({
  type: z.literal('ABORT_TURN'),
  sessionId: z.string(),
});

export const ClientEventSchema = z.discriminatedUnion('type', [
  CreateSessionSchema,
  ListSessionsSchema,
  AttachSessionSchema,
  DetachSessionSchema,
  RemoveSessionSchema,
  StartTurnSchema,
  ToolCallResultSchema,
  FetchHistorySchema,
  ToolResultFetchSchema,
  AbortTurnSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export function parseClientEvent(
  raw: string,
): { ok: true; event: ClientEvent } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = ClientEventSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, event: result.data };
}
