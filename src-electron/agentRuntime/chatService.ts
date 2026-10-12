import WebSocket from 'ws';
import { getLogger } from '../../dist/utils/logger';

export interface HermesChatEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface HermesChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

interface JsonRpcFrame {
  id?: string | number;
  method?: string;
  params?: HermesChatEvent;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Main-process WebSocket client for Hermes's local JSON-RPC gateway. */
export class HermesChatService {
  private readonly logger = getLogger();
  private socket: WebSocket | null = null;
  private nextRequestId = 0;
  private sessionId: string | null = null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private eventListener: ((event: HermesChatEvent) => void) | null = null;
  private readyPromise: Promise<void> | null = null;

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(port = 8642, token?: string): Promise<{ success: boolean; message: string }> {
    if (this.connected) return { success: true, message: 'Already connected' };

    const sessionToken = token || process.env.HERMES_SESSION_TOKEN;
    const auth = sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : '';
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws${auth}`);
    this.socket = socket;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for Hermes gateway readiness')), 15000);
      socket.on('message', (raw) => {
        const ready = this.handleFrame(raw.toString());
        if (ready) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.rejectPending(new Error('Hermes gateway WebSocket closed'));
    });
    socket.on('error', (error) => this.logger.warn('Hermes chat WebSocket error', { error }));

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out connecting to Hermes gateway')), 15000);
        socket.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      await this.readyPromise;
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.terminate();
      this.readyPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      if (!sessionToken && /closed|timeout/i.test(message)) {
        throw new Error('Hermes gateway authentication is required. Enter its loopback session token and try again.');
      }
      throw error;
    }
    this.readyPromise = null;

    return { success: true, message: 'Connected to Hermes gateway' };
  }

  async createSession(): Promise<{ success: boolean; sessionId?: string; message: string }> {
    const result = await this.request<{ session_id?: string }>('session.create');
    const sessionId = result.session_id;
    if (!sessionId) throw new Error('Hermes did not return a session ID');
    this.sessionId = sessionId;
    return { success: true, sessionId, message: 'Session created' };
  }

  async sendMessage(text: string): Promise<{ success: boolean; message: string }> {
    const cleanText = text.trim();
    if (!cleanText || cleanText.length > 20000) throw new Error('Message must contain 1-20,000 characters');
    if (!this.sessionId) await this.createSession();
    await this.request('prompt.submit', { session_id: this.sessionId, text: cleanText });
    return { success: true, message: 'Message submitted' };
  }

  async respondToRequest(
    type: 'approval' | 'secret' | 'sudo' | 'clarify',
    value: string,
    requestId?: string,
    sessionId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const cleanValue = value.trim();
    if (cleanValue.length > 20000) throw new Error('Response is too long');

    const params: Record<string, unknown> = {};
    let method: string;
    if (type === 'approval') {
      if (!['once', 'session', 'always', 'deny'].includes(cleanValue)) {
        throw new Error('Invalid approval choice');
      }
      method = 'approval.respond';
      params.choice = cleanValue;
      params.session_id = sessionId || this.sessionId;
    } else if (type === 'clarify') {
      if (!requestId) throw new Error('Clarification request ID is required');
      method = 'clarify.respond';
      params.clarify_id = requestId;
      params.response = value;
    } else {
      if (!requestId) throw new Error('Request ID is required');
      method = `${type}.respond`;
      params.request_id = requestId;
      params[type === 'sudo' ? 'password' : 'value'] = value;
    }

    await this.request(method, params);
    return { success: true, message: 'Hermes request resolved' };
  }

  setEventListener(listener: ((event: HermesChatEvent) => void) | null): void {
    this.eventListener = listener;
  }

  disconnect(): void {
    this.sessionId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.rejectPending(new Error('Hermes chat disconnected'));
  }

  dispose(): void {
    this.disconnect();
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Hermes gateway is not connected'));
    const id = `novaris-${++this.nextRequestId}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes request timed out: ${method}`));
      }, 120000);
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
      if (frame.error) pending.reject(new Error(frame.error.message || 'Hermes RPC request failed'));
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
