import axios from 'axios';
import { getLogger } from '../utils/logger';
import { HermesBootstrapPayload } from '../types/hermes';
import { HermesDetectorService } from './hermesDetectorService';

export interface HermesBootstrapRequest {
  apiUrl: string;
  installCode: string;
  deviceId: number;
}

export interface HermesBootstrapResult {
  payload: HermesBootstrapPayload;
  /**
   * True when an existing, unmanaged Hermes installation was detected on
   * this device. Callers MUST skip downloading/installing/spawning the
   * bundled Hermes runtime when this is true.
   */
  skipManagedInstall: boolean;
}

/**
 * Exchanges a one-time Hermes install code for a locked runtime bootstrap
 * payload. Before contacting the backend, this checks whether Hermes is
 * already installed locally so we never install a second, conflicting
 * instance on top of the user's existing setup — the backend is informed
 * via `existing_hermes_detected` so the install record reflects reality
 * instead of being marked "activated" for a runtime Novaris doesn't manage.
 */
export class HermesBootstrapService {
  private logger = getLogger();

  constructor(private detector: HermesDetectorService = new HermesDetectorService()) {}

  async bootstrap(request: HermesBootstrapRequest): Promise<HermesBootstrapResult> {
    const detection = this.detector.detect();

    if (detection.detected) {
      this.logger.info(
        'Skipping managed Hermes installation; existing local Hermes installation detected',
        { method: detection.method, path: detection.detectedAt }
      );
    }

    const response = await axios.post(
      `${request.apiUrl}/hermes-installs/bootstrap`,
      {
        install_code: request.installCode,
        device_id: request.deviceId,
        existing_hermes_detected: detection.detected,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const payload = this.toBootstrapPayload(response.data?.data);

    return {
      payload,
      skipManagedInstall: detection.detected || payload.existingHermesDetected,
    };
  }

  private toBootstrapPayload(data: any): HermesBootstrapPayload {
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
      releaseMetadata: {
        id: data.release_metadata?.id,
        version: data.release_metadata?.version,
        osType: data.release_metadata?.os_type,
        arch: data.release_metadata?.arch ?? null,
        artifactType: data.release_metadata?.artifact_type ?? null,
        downloadUrl: data.release_metadata?.download_url,
      },
      installToken: data.install_token ?? null,
      existingHermesDetected: Boolean(data.existing_hermes_detected ?? data.status === 'existing_hermes_detected'),
    };
  }
}
