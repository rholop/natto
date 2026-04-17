import { z } from 'zod';

export const PROVIDERS = ['claude-code', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

const ProviderSchema = z.enum(PROVIDERS);

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const CreateSessionSchema = z.object({
  type: z.literal('CREATE_SESSION'),
  provider: ProviderSchema,
  cwd: z.string(),
});

export const ListSessionsSchema = z.object({
  type: z.literal('LIST_SESSIONS'),
});

export const RemoveSessionSchema = z.object({
  type: z.literal('REMOVE_SESSION'),
  sessionId: z.string(),
});

export const RunStartedSchema = z.object({
  type: z.literal('RUN_STARTED'),
  runId: z.string(),
  sessionId: z.string(),
  messages: z.array(MessageSchema).min(1),
});

export const ToolCallResultSchema = z.object({
  type: z.literal('TOOL_CALL_RESULT'),
  toolCallId: z.string(),
  approved: z.boolean(),
  content: z.string().optional(),
});

export const ClientEventSchema = z.discriminatedUnion('type', [
  CreateSessionSchema,
  ListSessionsSchema,
  RemoveSessionSchema,
  RunStartedSchema,
  ToolCallResultSchema,
]);

export type CreateSessionEvent = z.infer<typeof CreateSessionSchema>;
export type ListSessionsEvent = z.infer<typeof ListSessionsSchema>;
export type RemoveSessionEvent = z.infer<typeof RemoveSessionSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedSchema>;
export type ToolCallResultEvent = z.infer<typeof ToolCallResultSchema>;
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  cwd: string;
  state: string;
  createdAt: number;
}

export type ServerEvent =
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant'; sessionId: string; runId: string }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string; sessionId: string; runId: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string; sessionId: string; runId: string }
  | {
      type: 'TOOL_CALL_START';
      toolCallId: string;
      toolCallName: string;
      parentMessageId: string;
      sessionId: string;
      runId: string;
    }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string; sessionId: string; runId: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string; sessionId: string; runId: string }
  | { type: 'RUN_FINISHED'; runId: string; sessionId: string; stopReason: string }
  | { type: 'SESSION_CREATED'; sessionId: string; provider: Provider; cwd: string; cliVersion?: string }
  | { type: 'SESSION_LIST'; sessions: SessionRecord[] }
  | {
      type: 'CLI_ERROR';
      sessionId: string;
      runId?: string;
      exitCode?: number;
      stderr?: string;
      reason?: string;
      message: string;
    };

export function parseClientEvent(raw: string): { ok: true; event: ClientEvent } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = ClientEventSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, event: result.data };
}
