import { spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../dist/utils/logger';
import { LockedAgentPolicy } from './runtimePolicy';

export interface AgentSupervisorOptions {
  resourcesPath: string;
  /** Where the runtime keeps its policy file, chat history and memory. */
  runtimeDir: string;
  isPackaged: boolean;
  /** Source checkout of `runtime/`, used in development instead of the bundle. */
  devRuntimeDir: string;
}

export interface RuntimeEndpoint {
  port: number;
  token: string;
}

const READY_PREFIX = 'NOVARIS_RUNTIME_READY ';
const READY_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;
// OS variables the runtime needs; nothing else from Electron's environment is passed through.
const PASSTHROUGH_ENV = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'TMPDIR', 'LANG', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];

/**
 * Supervises the bundled Deep Agents runtime: starts it with the locked policy,
 * waits for it to report its port, restarts it with backoff if it crashes, and
 * stops it by closing its stdin (the runtime exits when stdin closes).
 */
export class AgentRuntimeSupervisor {
  private readonly logger = getLogger();
  private child: ChildProcess | null = null;
  private endpoint: RuntimeEndpoint | null = null;
  private starting: Promise<RuntimeEndpoint> | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 1_000;
  private launch: { policy: LockedAgentPolicy; accessToken: string } | null = null;

  constructor(private readonly options: AgentSupervisorOptions) {}

  get isRunning(): boolean {
    return this.endpoint !== null;
  }

  /** Starts the runtime (or returns the running/starting one) and resolves once it accepts connections. */
  start(policy: LockedAgentPolicy, accessToken: string): Promise<RuntimeEndpoint> {
    this.launch = { policy, accessToken };
    this.stopping = false;
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (!this.starting) {
      this.starting = this.spawnRuntime().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Hands a refreshed user JWT to the running runtime over stdin; later restarts use it too. */
  updateAccessToken(accessToken: string): void {
    if (!this.launch || this.launch.accessToken === accessToken) return;
    this.launch = { ...this.launch, accessToken };
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.write(`${JSON.stringify({ type: 'access_token', token: accessToken })}\n`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    this.logger.info('Agent runtime stopped');
  }

  private spawnRuntime(): Promise<RuntimeEndpoint> {
    const launch = this.launch;
    if (!launch) return Promise.reject(new Error('Agent runtime has no policy to start with'));
    const command = this.resolveCommand();
    if (!command) {
      return Promise.reject(new Error('The bundled agent runtime was not found; reinstall the app'));
    }

    const policyPath = path.join(this.options.runtimeDir, 'runtime-policy.json');
    const dataDir = path.join(this.options.runtimeDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify(launch.policy, null, 2), { encoding: 'utf8', mode: 0o600 });

    const runtimeToken = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      NOVARIS_POLICY_FILE: policyPath,
      NOVARIS_ACCESS_TOKEN: launch.accessToken,
      NOVARIS_RUNTIME_TOKEN: runtimeToken,
      NOVARIS_DATA_DIR: dataDir,
      NOVARIS_RUNTIME_PORT: '0',
      PYTHONUNBUFFERED: '1',
    });

    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // A token update can race the process exiting; EPIPE here is harmless.
    child.stdin?.on('error', (error) => this.logger.debug('Agent runtime stdin closed', { error: error.message }));

    return new Promise<RuntimeEndpoint>((resolve, reject) => {
      let settled = false;
      let buffered = '';
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(error);
      };
      const readyTimer = setTimeout(() => {
        fail(new Error('Agent runtime did not become ready in time'));
        child.kill();
      }, READY_TIMEOUT_MS);

      child.stdout?.on('data', (data: Buffer) => {
        buffered += data.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!settled && line.startsWith(READY_PREFIX)) {
            const { port } = JSON.parse(line.slice(READY_PREFIX.length)) as { port: number };
            settled = true;
            clearTimeout(readyTimer);
            this.endpoint = { port, token: runtimeToken };
            this.restartDelayMs = 1_000;
            this.logger.info('Agent runtime ready', { port, model: launch.policy.model });
            resolve(this.endpoint);
          } else if (line.trim()) {
            this.logRuntimeLine(line);
          }
        }
      });
      child.stderr?.on('data', (data: Buffer) => this.logger.warn('Agent runtime stderr', { output: data.toString().trim() }));
      child.on('error', (error) => {
        this.logger.error('Agent runtime process failed', { error });
        fail(error);
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.endpoint = null;
        }
        fail(new Error(`Agent runtime exited during startup (code ${code})`));
        this.logger.info('Agent runtime exited', { code, signal });
        if (code === 2) {
          this.logger.error('Agent runtime rejected its configuration; not restarting');
        } else if (!this.stopping) {
          this.scheduleRestart();
        }
      });
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.launch) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, MAX_RESTART_DELAY_MS);
    this.logger.warn('Restarting agent runtime', { delayMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || !this.launch) return;
      this.start(this.launch.policy, this.launch.accessToken).catch((error) =>
        this.logger.error('Agent runtime restart failed', { error: error.message })
      );
    }, delay);
  }

  private logRuntimeLine(line: string): void {
    try {
      const entry = JSON.parse(line) as { level?: string; message?: string };
      const level = entry.level === 'error' || entry.level === 'critical' ? 'error' : entry.level === 'warning' ? 'warn' : 'info';
      this.logger[level](`Agent runtime: ${entry.message ?? ''}`, entry);
    } catch {
      this.logger.info('Agent runtime output', { output: line });
    }
  }

  private resolveCommand(): { file: string; args: string[]; cwd: string } | null {
    const executableName = process.platform === 'win32' ? 'novaris-runtime.exe' : 'novaris-runtime';
    const bundled = path.join(this.options.resourcesPath, 'agent-runtime', executableName);
    if (fs.existsSync(bundled)) {
      return { file: bundled, args: [], cwd: path.dirname(bundled) };
    }

    // Development: run the Python source with uv (see runtime/README.md).
    if (!this.options.isPackaged && fs.existsSync(path.join(this.options.devRuntimeDir, 'pyproject.toml'))) {
      return { file: 'uv', args: ['run', '--frozen', 'python', '-m', 'novaris_runtime'], cwd: this.options.devRuntimeDir };
    }
    return null;
  }
}
