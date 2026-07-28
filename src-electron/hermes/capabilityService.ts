import axios from 'axios';
import { getLogger } from '../../dist/utils/logger';
import { LockedHermesPolicy } from './runtimePolicy';
import { HermesProcessSupervisor } from './processSupervisor';

interface CapabilityStatus {
  state: 'active' | 'quota_exceeded' | 'suspended' | 'not_configured';
  enabled: boolean;
}

export class HermesCapabilityService {
  private readonly logger = getLogger();
  private timer: NodeJS.Timeout | null = null;
  private stoppedByPolicy = false;

  start(policy: LockedHermesPolicy, supervisor: HermesProcessSupervisor): void {
    this.stop();
    const poll = () => this.poll(policy, supervisor).catch((error) => {
      this.logger.warn('Hermes capability status check failed', { error });
    });
    void poll();
    this.timer = setInterval(poll, 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(policy: LockedHermesPolicy, supervisor: HermesProcessSupervisor): Promise<void> {
    if (!policy.installToken) return;
    const response = await axios.get<{ data: CapabilityStatus }>(
      `${policy.backendBaseUrl}/api/v1/hermes-installs/capability-status`,
      {
        params: { install_id: policy.installId },
        headers: { Authorization: `Bearer ${policy.installToken}` },
        timeout: 30000,
      }
    );
    const status = response.data.data;
    if (!status.enabled && !this.stoppedByPolicy) {
      await supervisor.stop();
      this.stoppedByPolicy = true;
      this.logger.warn('Managed Hermes stopped by backend capability policy', { state: status.state });
    } else if (status.enabled && this.stoppedByPolicy) {
      const result = supervisor.start(policy);
      this.stoppedByPolicy = !result.started;
      this.logger.info('Managed Hermes capability restored', { started: result.started });
    }
  }
}