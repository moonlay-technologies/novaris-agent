import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../dist/utils/logger';
import { LockedHermesPolicy } from './runtimePolicy';

export interface HermesSupervisorOptions {
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
}

/** Supervises the bundled Hermes process without allowing user config overrides. */
export class HermesProcessSupervisor {
  private readonly logger = getLogger();
  private child: ChildProcess | null = null;
  private policyFilePath: string | null = null;

  constructor(private readonly options: HermesSupervisorOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  start(policy: LockedHermesPolicy): { started: boolean; reason?: string } {
    if (this.isRunning) {
      return { started: true };
    }

    const executablePath = this.resolveExecutablePath();
    if (!executablePath) {
      const reason = 'Bundled Hermes executable was not found; managed runtime was not started';
      this.logger.warn(reason);
      return { started: false, reason };
    }

    const policyPath = path.join(this.options.userDataPath, 'hermes', 'runtime-policy.json');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.mkdirSync(policy.workspacePath, { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.policyFilePath = policyPath;

    const child = spawn(executablePath, ['--config', policyPath], {
      cwd: policy.workspacePath,
      env: {
        PATH: process.env.PATH || '',
        HERMES_CONFIG_FILE: policyPath,
        HERMES_BACKEND_URL: policy.backendBaseUrl,
        HERMES_PROXY_ENDPOINT: policy.proxyEndpointUrl,
        HERMES_POLICY_VERSION: policy.policyVersion,
        HERMES_ALLOWED_TOOLS: policy.allowedTools.join(','),
        HERMES_WORKSPACE_DIR: policy.workspacePath,
        ...(policy.installToken ? { HERMES_INSTALL_TOKEN: policy.installToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout?.on('data', (data: Buffer) => this.logger.info('Hermes runtime output', { output: data.toString().trim() }));
    child.stderr?.on('data', (data: Buffer) => this.logger.warn('Hermes runtime error output', { output: data.toString().trim() }));
    child.on('error', (error) => this.logger.error('Hermes runtime process failed', { error }));
    child.on('exit', (code, signal) => {
      this.logger.info('Hermes runtime stopped', { code, signal });
      this.child = null;
    });

    this.child = child;
    this.logger.info('Hermes managed runtime started', { policyVersion: policy.policyVersion });
    return { started: true };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) {
      return;
    }

    child.kill();
    this.logger.info('Hermes managed runtime stop requested');
  }

  private resolveExecutablePath(): string | null {
    const executableName = process.platform === 'win32' ? 'hermes.exe' : 'hermes';
    const candidates = [
      path.join(this.options.resourcesPath, 'hermes', executableName),
      path.join(this.options.resourcesPath, executableName),
    ];

    if (!this.options.isPackaged && process.env.HERMES_EXECUTABLE_PATH) {
      candidates.unshift(process.env.HERMES_EXECUTABLE_PATH);
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }
}
