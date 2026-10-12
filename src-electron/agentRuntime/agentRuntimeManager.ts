import * as fs from 'fs';
import * as path from 'path';
import { AgentBootstrapService } from '../../dist/services/agentBootstrapService';
import { getLogger } from '../../dist/utils/logger';
import { AgentHeartbeatService } from './heartbeatService';
import { InstallTokenStore } from './installTokenStore';
import { AgentRuntimePolicy, LockedAgentPolicy } from './runtimePolicy';
import { AgentRuntimeSupervisor, RuntimeEndpoint } from './supervisor';

export interface AgentRuntimeStatus {
  activated: boolean;
  running: boolean;
  model: string | null;
  workspacePath: string | null;
  /** False when the OS cannot encrypt the install token, so it must be re-entered after a restart. */
  tokenPersisted: boolean;
}

export interface AgentRuntimeManagerOptions {
  runtimeDir: string;
  supervisor: AgentRuntimeSupervisor;
  heartbeat?: AgentHeartbeatService;
  bootstrapService?: AgentBootstrapService;
}

/**
 * Owns the lifecycle of the local agent runtime: activation with an install
 * code, restoring it on launch, and stopping it on quit.
 */
export class AgentRuntimeManager {
  private readonly logger = getLogger();
  private readonly policyPath: string;
  private readonly tokenStore: InstallTokenStore;
  private readonly supervisor: AgentRuntimeSupervisor;
  private readonly heartbeat: AgentHeartbeatService;
  private readonly bootstrapService: AgentBootstrapService;
  private policy: LockedAgentPolicy | null = null;
  private installToken: string | null = null;
  private tokenPersisted = false;

  constructor(options: AgentRuntimeManagerOptions) {
    this.policyPath = path.join(options.runtimeDir, 'locked-policy.json');
    this.tokenStore = new InstallTokenStore(path.join(options.runtimeDir, 'install-token.bin'));
    this.supervisor = options.supervisor;
    this.heartbeat = options.heartbeat ?? new AgentHeartbeatService();
    this.bootstrapService = options.bootstrapService ?? new AgentBootstrapService();
  }

  status(): AgentRuntimeStatus {
    return {
      activated: this.policy !== null && this.installToken !== null,
      running: this.supervisor.isRunning,
      model: this.policy?.model ?? null,
      workspacePath: this.policy?.workspacePath ?? null,
      tokenPersisted: this.tokenPersisted,
    };
  }

  /** Activates the assistant on this device with a one-time install code from an administrator. */
  async activate(apiUrl: string, deviceId: number, installCode: string): Promise<AgentRuntimeStatus> {
    const payload = await this.bootstrapService.bootstrap({ apiUrl, installCode: installCode.trim(), deviceId });
    if (!payload.installToken) {
      throw new Error('The server did not issue an install token');
    }
    const policy = AgentRuntimePolicy.fromBootstrap(payload);

    await this.supervisor.stop();
    AgentRuntimePolicy.write(policy, this.policyPath);
    this.tokenPersisted = this.tokenStore.save(payload.installToken);
    if (!this.tokenPersisted) {
      this.logger.warn('OS encryption is unavailable; the install token will not survive an app restart');
    }

    this.policy = policy;
    this.installToken = payload.installToken;
    this.logger.info('Agent activated', { installId: policy.installId, model: policy.model });
    await this.startRuntime();
    return this.status();
  }

  /** Restarts a previously activated runtime when the app launches. */
  async restore(): Promise<void> {
    if (!fs.existsSync(this.policyPath)) return;
    const installToken = this.tokenStore.load();
    if (!installToken) {
      this.logger.warn('Saved agent policy found but no usable install token; activation is required');
      return;
    }
    try {
      this.policy = AgentRuntimePolicy.read(this.policyPath);
    } catch (error) {
      this.logger.error('Saved agent policy is unreadable; activation is required', { error });
      return;
    }
    this.installToken = installToken;
    this.tokenPersisted = true;
    await this.startRuntime();
  }

  /** Endpoint for the chat client; starts the runtime if it is activated but not running. */
  async endpoint(): Promise<RuntimeEndpoint> {
    if (!this.policy || !this.installToken) {
      throw new Error('The assistant is not activated on this device yet. Enter an install code first.');
    }
    return this.supervisor.start(this.policy, this.installToken);
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    await this.supervisor.stop();
  }

  private async startRuntime(): Promise<void> {
    if (!this.policy || !this.installToken) return;
    this.heartbeat.start(this.policy, this.installToken);
    try {
      await this.supervisor.start(this.policy, this.installToken);
    } catch (error) {
      // The chat panel retries on connect; activation itself still succeeded.
      this.logger.error('Agent runtime failed to start', { error: (error as Error).message });
    }
  }
}
