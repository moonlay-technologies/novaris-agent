import axios from 'axios';
import { AgentBootstrapPayload } from '../types/agentRuntime';

export interface AgentBootstrapRequest {
  apiUrl: string;
  installCode: string;
  deviceId: number;
}

/**
 * Exchanges a one-time install code for the locked runtime policy and the
 * install token the local agent runtime uses to reach the backend.
 */
export class AgentBootstrapService {
  async bootstrap(request: AgentBootstrapRequest): Promise<AgentBootstrapPayload> {
    const response = await axios.post(
      `${request.apiUrl.replace(/\/$/, '')}/agent-installs/bootstrap`,
      {
        install_code: request.installCode,
        device_id: request.deviceId,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    return this.toBootstrapPayload(response.data?.data);
  }

  private toBootstrapPayload(data: any): AgentBootstrapPayload {
    return {
      installId: data.install_id,
      deviceBinding: {
        deviceId: data.device_binding?.device_id,
        userId: data.device_binding?.user_id ?? null,
        clientId: data.device_binding?.client_id,
        branchId: data.device_binding?.branch_id ?? null,
      },
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
      releaseMetadata: {
        id: data.release_metadata?.id,
        version: data.release_metadata?.version,
        osType: data.release_metadata?.os_type,
        arch: data.release_metadata?.arch ?? null,
        artifactType: data.release_metadata?.artifact_type ?? null,
        downloadUrl: data.release_metadata?.download_url,
      },
      installToken: data.install_token ?? null,
    };
  }
}
