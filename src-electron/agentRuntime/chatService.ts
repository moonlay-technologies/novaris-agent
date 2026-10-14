import WebSocket from 'ws';
import { getLogger } from '../../dist/utils/logger';
import { RuntimeEndpoint } from './supervisor';

export interface AgentChatEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export type AgentChatResponseType = 'approval' | 'clarify';

interface JsonRpcFrame {
  id?: string | number;
  method?: string;
  params?: AgentChatEvent;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

/** Main-process WebSocket client for the local agent runtime's JSON-RPC server. */
export class AgentChatService {
  private readonly logger = getLogger();
  private socket: WebSocket | null = null;
  private nextRequestId = 0;
  private sessionId: string | null = null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private eventListener: ((event: AgentChatEvent) => void) | null = null;

  constructor(private readonly resolveEndpoint: () => Promise<RuntimeEndpoint>) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<{ success: boolean; message: string }> {
    if (this.connected) return { success: true, message: 'Already connected' };

    const { port, token } = await this.resolveEndpoint();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
    this.socket = socket;

    // The runtime sends `gateway.ready` as soon as the connection is accepted.
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the assistant to respond')), CONNECT_TIMEOUT_MS);
      socket.on('message', (raw) => {
        if (this.handleFrame(raw.toString())) {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('The assistant closed the connection'));
      });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.rejectPending(new Error('Connection to the assistant was closed'));
      this.eventListener?.({ type: 'connection.closed' });
    });
    socket.on('error', (error) => this.logger.warn('Agent chat WebSocket error', { error: error.message }));

    try {
      await ready;
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.terminate();
      throw error;
    }
    return { success: true, message: 'Connected to the assistant' };
  }

  /** Starts a new conversation, or reattaches to a saved one when `sessionId` is given. */
  async createSession(sessionId?: string): Promise<{ success: boolean; sessionId?: string; message: string }> {
    const result = await this.request<{ session_id?: string }>('session.create', sessionId ? { session_id: sessionId } : {});
    if (!result.session_id) throw new Error('The assistant did not return a session ID');
    this.sessionId = result.session_id;
    return { success: true, sessionId: result.session_id, message: 'Session created' };
  }

  async sendMessage(text: string): Promise<{ success: boolean; message: string }> {
    const cleanText = text.trim();
    if (!cleanText || cleanText.length > 20000) throw new Error('Message must contain 1-20,000 characters');
    if (!this.sessionId) await this.createSession();
    await this.request('prompt.submit', { session_id: this.sessionId, text: cleanText });
    return { success: true, message: 'Message submitted' };
  }

  async respondToRequest(
    type: AgentChatResponseType,
    value: string,
    requestId?: string,
    sessionId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (value.length > 20000) throw new Error('Response is too long');

    if (type === 'approval') {
      const choice = value.trim();
      if (!['once', 'session', 'always', 'deny'].includes(choice)) throw new Error('Invalid approval choice');
      await this.request('approval.respond', { choice, session_id: sessionId || this.sessionId });
    } else if (type === 'clarify') {
      if (!requestId) throw new Error('Clarification request ID is required');
      await this.request('clarify.respond', { clarify_id: requestId, response: value });
    } else {
      throw new Error('Unsupported response type');
    }
    return { success: true, message: 'Request answered' };
  }

  setEventListener(listener: ((event: AgentChatEvent) => void) | null): void {
    this.eventListener = listener;
  }

  disconnect(): void {
    this.sessionId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.rejectPending(new Error('Disconnected from the assistant'));
  }

  dispose(): void {
    this.disconnect();
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Not connected to the assistant'));
    const id = `novaris-${++this.nextRequestId}`;

    return new Promise<T>((resolve, reject) => {
      // Requests are acknowledged immediately; answers stream back as events.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Assistant request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      try {
        this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Handles one frame; returns true when it is the runtime's ready event. */
  private handleFrame(raw: string): boolean {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(raw) as JsonRpcFrame;
    } catch (_error) {
      return false;
    }

    if (frame.id !== undefined && frame.id !== null) {
      const pending = this.pending.get(frame.id);
      if (!pending) return false;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || 'Assistant request failed'));
      else pending.resolve(frame.result);
      return false;
    }

    if (frame.method === 'event' && frame.params) {
      this.eventListener?.(frame.params);
      return frame.params.type === 'gateway.ready';
    }
    return false;
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
