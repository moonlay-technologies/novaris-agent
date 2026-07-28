import WebSocket from 'ws';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getLogger } from '../../dist/utils/logger';
import { HermesDetectorService } from '../../dist/services/hermesDetectorService';

export interface HermesChatEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface HermesChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface HermesCommandCategory {
  name: string;
  commands: Array<{ command: string; description: string }>;
}

interface HermesCommandResult {
  type?: 'send' | 'exec' | 'alias' | 'skill' | 'prefill';
  output?: string;
  message?: string;
  notice?: string;
  target?: string;
  text?: string;
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

/** Main-process client for Hermes's local JSON-RPC gateway. */
export class HermesChatService {
  private readonly logger = getLogger();
  private readonly detector = new HermesDetectorService();
  private socket: WebSocket | null = null;
  private localProcess: ChildProcess | null = null;
  private localLines: readline.Interface | null = null;
  private nextRequestId = 0;
  private sessionId: string | null = null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private eventListener: ((event: HermesChatEvent) => void) | null = null;
  private readyPromise: Promise<void> | null = null;


  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
      || Boolean(this.localProcess && this.localProcess.exitCode === null && !this.localProcess.killed);
  }

  async connectLocal(): Promise<{ success: boolean; message: string }> {
    if (this.connected) return { success: true, message: 'Already connected' };

    const detection = this.detector.detect();
    if (!detection.detected || !detection.executablePath) {
      throw new Error('Hermes Agent was not found. Install Hermes or set HERMES_EXECUTABLE_PATH.');
    }

    const projectRoot = path.resolve(detection.executablePath, '..', '..', '..');
    const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
    const python = path.join(path.dirname(detection.executablePath), pythonName);
    if (!fs.existsSync(python)) {
      throw new Error(`Hermes Python runtime was not found beside ${detection.executablePath}.`);
    }

    // Hermes' stdio gateway queues the first prompt while its lazy agent is
    // hydrating, but the stock readiness wait is only 30 seconds. Tool/MCP
    // discovery can exceed that on a cold or slower machine, causing exactly
    // one failed turn while initialization continues. Extend only this managed
    // process's function default without modifying the user's Hermes files.
    const bootstrap = [
      'import runpy',
      'from tui_gateway import server',
      "setattr(server._wait_agent, '__defaults__', (300.0,)) if hasattr(server, '_wait_agent') else None",
      "runpy.run_module('tui_gateway.entry', run_name='__main__')",
    ].join(';');
    const child = spawn(python, ['-u', '-c', bootstrap], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HERMES_HOME: detection.hermesHome,
        HERMES_PYTHON_SRC_ROOT: projectRoot,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.localProcess = child;
    this.localLines = readline.createInterface({ input: child.stdout! });

    let startupError = '';
    child.stderr?.on('data', (data: Buffer) => {
      startupError = `${startupError}${data.toString()}`.slice(-2000);
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the embedded Hermes runtime')), 15000);
      const ready = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.localLines?.on('line', (line) => {
        if (this.handleFrame(line)) ready();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        const detail = startupError.trim();
        reject(new Error(
          `Embedded Hermes runtime exited before becoming ready (code ${code ?? 'unknown'}).`
          + (detail ? ` ${detail}` : '')
        ));
      });
    });

    child.on('exit', (code, signal) => {
      this.logger.info('Embedded Hermes runtime stopped', { code, signal });
      if (this.localProcess === child) {
        this.localProcess = null;
        this.localLines?.close();
        this.localLines = null;
      }
      this.rejectPending(new Error('Embedded Hermes runtime stopped'));
    });

    try {
      await this.readyPromise;
    } catch (error) {
      this.stopLocalProcess();
      throw error;
    } finally {
      this.readyPromise = null;
    }

    return { success: true, message: 'Connected to the Novaris-managed Hermes runtime' };
  }

  async connect(port = 9119, token?: string): Promise<{ success: boolean; message: string }> {
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
        throw new Error('Hermes dashboard authentication is required. Enter its loopback session token and try again.');
      }
      throw error;
    }
    this.readyPromise = null;

    return { success: true, message: 'Connected to Hermes dashboard' };
  }

  async createSession(): Promise<{ success: boolean; sessionId?: string; message: string }> {
    try {
      const result = await this.request<{ session_id?: string }>('session.create');
      const sessionId = result.session_id;
      if (!sessionId) throw new Error('Hermes did not return a session ID');
      this.sessionId = sessionId;
      return { success: true, sessionId, message: 'Session created; Hermes is initializing in the background' };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return { success: false, message: failure.message };
    }
  }

  async listCommands(): Promise<{ success: boolean; categories: HermesCommandCategory[]; message: string }> {
    const result = await this.request<{
      categories?: Array<{ name?: unknown; pairs?: unknown }>;
      warning?: unknown;
    }>('commands.catalog');
    const categories = (Array.isArray(result.categories) ? result.categories : [])
      .slice(0, 50)
      .map((category) => ({
        name: typeof category.name === 'string' ? category.name.slice(0, 100) : 'Commands',
        commands: (Array.isArray(category.pairs) ? category.pairs : [])
          .slice(0, 100)
          .flatMap((pair) => {
            if (!Array.isArray(pair) || typeof pair[0] !== 'string') return [];
            return [{
              command: pair[0].slice(0, 100),
              description: typeof pair[1] === 'string' ? pair[1].slice(0, 300) : '',
            }];
          }),
      }))
      .filter((category) => category.commands.length > 0);
    const warning = typeof result.warning === 'string' ? result.warning.slice(0, 500) : '';
    return {
      success: true,
      categories,
      message: warning || `${categories.reduce((count, category) => count + category.commands.length, 0)} commands available`,
    };
  }

  async sendMessage(text: string): Promise<{ success: boolean; message: string; output?: string; prefill?: string; sessionId?: string }> {
    const cleanText = text.trim();
    if (!cleanText || cleanText.length > 20000) throw new Error('Message must contain 1-20,000 characters');
    if (!this.sessionId) {
      const session = await this.createSession();
      if (!session.success) return { success: false, message: session.message };
    }
    if (cleanText.startsWith('/')) return this.executeCommand(cleanText);
    await this.request('prompt.submit', { session_id: this.sessionId, text: cleanText });

    return { success: true, message: 'Message accepted' };
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
    this.stopLocalProcess();
    this.rejectPending(new Error('Hermes chat disconnected'));
  }

  dispose(): void {
    this.disconnect();
  }

  private async executeCommand(command: string): Promise<{ success: boolean; message: string; output?: string; prefill?: string; sessionId?: string }> {
    const commandText = command.slice(1).trim();
    const separator = commandText.search(/\s/);
    const name = (separator === -1 ? commandText : commandText.slice(0, separator)).toLowerCase();
    const arg = separator === -1 ? '' : commandText.slice(separator + 1).trim();
    if (!name) throw new Error('Enter a command after /');

    // `/new` is a local TUI session-boundary command in Hermes. It is not a
    // gateway slash command: forwarding it to slash.exec makes the slash
    // worker wait for the deferred agent build and can time out on the first
    // invocation. Recreate the lightweight gateway session directly instead.
    if (name === 'new') {
      this.sessionId = null;
      const session = await this.createSession();
      if (!session.success) throw new Error(session.message);
      return {
        success: true,
        message: '(^_^)v New session started!',
        sessionId: session.sessionId,
      };
    }

    const dispatchFirst = new Set(['retry', 'queue', 'q', 'steer', 'plan', 'goal', 'undo']);
    let result: HermesCommandResult;
    if (dispatchFirst.has(name)) {
      result = await this.request<HermesCommandResult>('command.dispatch', {
        session_id: this.sessionId,
        name,
        arg,
      });
    } else {
      try {
        result = await this.request<HermesCommandResult>('slash.exec', {
          session_id: this.sessionId,
          command,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/use command\.dispatch/i.test(message)) throw error;
        result = await this.request<HermesCommandResult>('command.dispatch', {
          session_id: this.sessionId,
          name,
          arg,
        });
      }
    }

    if (result.type === 'send' && result.message) {
      await this.request('prompt.submit', { session_id: this.sessionId, text: result.message });
    } else if (result.type === 'skill' && result.message) {
      await this.request('prompt.submit', { session_id: this.sessionId, text: result.message });
    }

    const output = [result.notice, result.output]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n');
    return {
      success: true,
      message: output || `Command /${name} accepted`,
      output: output || undefined,
      prefill: result.type === 'prefill'
        ? (typeof result.text === 'string' ? result.text : result.message)
        : undefined,
    };
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('Hermes gateway is not connected'));
    const id = `novaris-${++this.nextRequestId}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes request timed out: ${method}`));
      }, 120000);
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      try {
        this.sendFrame({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }


  private sendFrame(frame: Record<string, unknown>): void {
    const encoded = JSON.stringify(frame);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encoded);
      return;
    }
    if (this.localProcess?.stdin?.writable) {
      this.localProcess.stdin.write(`${encoded}\n`);
      return;
    }
    throw new Error('Hermes gateway is not connected');
  }

  private stopLocalProcess(): void {
    const child = this.localProcess;
    this.localProcess = null;
    this.localLines?.close();
    this.localLines = null;
    if (!child || child.exitCode !== null || child.killed) return;
    child.stdin?.end();
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
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
      const event = frame.params;
      if (event.type === 'session.info') {
        // The first prompt can already be submitted while Hermes initializes.
      } else if (event.type === 'error') {
        const payload = event.payload || {};
        const message = typeof payload.message === 'string' ? payload.message : 'Hermes agent initialization failed';
        this.logger.warn('Hermes agent initialization failed', { error: message });

      }
      this.eventListener?.(event);
      return event.type === 'gateway.ready';
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
