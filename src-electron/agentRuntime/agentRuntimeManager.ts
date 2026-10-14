import * as fs from 'fs';
import * as path from 'path';
import { AssistantPolicyPayload } from '../../dist/types/agentRuntime';
import { getLogger } from '../../dist/utils/logger';
import { AgentRuntimePolicy, LockedAgentPolicy } from './runtimePolicy';
import { AgentRuntimeSupervisor, RuntimeEndpoint } from './supervisor';

export interface AgentRuntimeStatus {
  /** True when a Novaris user is signed in, which is all the assistant needs. */
  available: boolean;
  running: boolean;
  model: string | null;
  workspacePath: string | null;
}

/** The parts of the user session the assistant depends on. */
export interface AssistantUserSession {
  isSignedIn(): boolean;
  getToken(): Promise<string>;
  request<T = unknown>(config: { method: 'GET'; url: string }): Promise<T>;
}

export interface AgentRuntimeManagerOptions {
  runtimeDir: string;
  supervisor: AgentRuntimeSupervisor;
  userSession: AssistantUserSession;
}

// Left behind by the install-code activation this manager replaced.
const LEGACY_FILES = ['install-token.bin', 'locked-policy.json'];

/**
 * Owns the lifecycle of the local agent runtime. It runs as the signed-in
 * Novaris user: the policy comes from `GET /me/assistant` and the runtime
 * calls the backend AI proxy with the user's JWT, which is pushed to the
 * runtime again whenever the session refreshes it.
 */
export class AgentRuntimeManager {
  private readonly logger = getLogger();
  private readonly supervisor: AgentRuntimeSupervisor;
  private readonly userSession: AssistantUserSession;
  private policy: LockedAgentPolicy | null = null;
  private loadingPolicy: Promise<LockedAgentPolicy> | null = null;

  constructor(options: AgentRuntimeManagerOptions) {
    this.supervisor = options.supervisor;
    this.userSession = options.userSession;
    for (const file of LEGACY_FILES) {
      fs.rmSync(path.join(options.runtimeDir, file), { force: true });
    }
  }

  status(): AgentRuntimeStatus {
    return {
      available: this.userSession.isSignedIn(),
      running: this.supervisor.isRunning,
      model: this.policy?.model ?? null,
      workspacePath: this.policy?.workspacePath ?? null,
    };
  }

  /** Endpoint for the chat client; starts the runtime as the signed-in user if it is not running. */
  async endpoint(): Promise<RuntimeEndpoint> {
    if (!this.userSession.isSignedIn()) {
      throw new Error('Sign in on the Account page to use the assistant.');
    }
    const policy = await this.loadPolicy();
    const token = await this.userSession.getToken();
    const endpoint = await this.supervisor.start(policy, token);
    this.supervisor.updateAccessToken(token);
    return endpoint;
  }

  /** Gives the running runtime the current JWT, refreshing it first if it is close to expiry. */
  async refreshAccessToken(): Promise<void> {
    if (!this.supervisor.isRunning || !this.userSession.isSignedIn()) return;
    this.supervisor.updateAccessToken(await this.userSession.getToken());
  }

  /** Stops the runtime and forgets the policy, e.g. when the user signs out. */
  async reset(): Promise<void> {
    this.policy = null;
    await this.supervisor.stop();
  }

  async stop(): Promise<void> {
    await this.supervisor.stop();
  }

  private loadPolicy(): Promise<LockedAgentPolicy> {
    if (this.policy) return Promise.resolve(this.policy);
    this.loadingPolicy ??= this.userSession
      .request<{ data: Record<string, any> }>({ method: 'GET', url: '/me/assistant' })
      .then((response) => {
        const policy = AgentRuntimePolicy.fromPayload(toPolicyPayload(response.data));
        this.policy = policy;
        this.logger.info('Assistant policy loaded', { model: policy.model, policyVersion: policy.policyVersion });
        return policy;
      })
      .finally(() => {
        this.loadingPolicy = null;
      });
    return this.loadingPolicy;
  }
}

function toPolicyPayload(data: Record<string, any>): AssistantPolicyPayload {
  return {
    backendBaseUrl: data.backend_base_url,
    proxyEndpointUrl: data.proxy_endpoint_url,
    policyVersion: data.policy_version,
    allowedTools: data.allowed_tools ?? [],
    workspacePathRule: data.workspace_path_rule,
    runtime: data.runtime ?? 'deepagents',
    model: data.model ?? 'gpt-4o-mini',
    maxInputTokens: Number(data.max_input_tokens) || 128000,
    systemPrompt: data.system_prompt ?? '',
    webSearchEndpointUrl: data.web_search_endpoint_url ?? null,
  };
}
