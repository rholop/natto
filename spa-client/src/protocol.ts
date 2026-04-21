export type ToolResultSummary = {
  preview: string;
  totalBytes: number;
  truncated: boolean;
  sidecarPath?: string;
};

export type MessageStatus = 'in_progress' | 'complete' | 'interrupted';

export type UserMessage = {
  role: 'user';
  messageId: string;
  content: string;
  at: number;
  status: 'complete';
};

export type AssistantMessage = {
  role: 'assistant';
  messageId: string;
  content: string;
  at: number;
  status: MessageStatus;
};

export type ToolCallMessage = {
  role: 'tool_call';
  messageId: string;
  toolCallId: string;
  name: string;
  args: string;
  approval: 'pending' | 'approved' | 'denied';
  result: ToolResultSummary | null;
  at: number;
  status: MessageStatus;
};

export type Message = UserMessage | AssistantMessage | ToolCallMessage;

export type MessageUpdate = {
  messageId: string;
  contentDelta?: string;
  approval?: 'approved' | 'denied';
  denialReason?: string;
  result?: ToolResultSummary;
  status?: MessageStatus;
  args?: string;
};

export type MessageEvent = {
  type: 'MESSAGE';
  seq: number;
  message: Message;
};

export type MessageUpdateEvent = {
  type: 'MESSAGE_UPDATE';
  seq: number;
  update: MessageUpdate;
};

export type HandledEvent = MessageEvent | MessageUpdateEvent;

export function isHandledEvent(value: unknown): value is HandledEvent {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'MESSAGE' || t === 'MESSAGE_UPDATE';
}
