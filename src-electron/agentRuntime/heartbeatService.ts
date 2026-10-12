import axios from 'axios';
import { getLogger } from '../../dist/utils/logger';
import { LockedAgentPolicy } from './runtimePolicy';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Periodically proves to the backend that this managed agent install is still alive. */
export class AgentHeartbeatService {
  private readonly logger = getLogger();
  private timer: NodeJS.Timeout | null = null;

  start(policy: LockedAgentPolicy, installToken: string): void {
    this.stop();
    const send = () => {
      this.sendHeartbeat(policy, installToken).catch((error) => {
        this.logger.warn('Agent heartbeat failed', { error: error.message });
      });
    };

    send();
    this.timer = setInterval(send, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sendHeartbeat(policy: LockedAgentPolicy, installToken: string): Promise<void> {
    await axios.post(
      `${policy.backendBaseUrl}/api/v1/agent-installs/heartbeat`,
      { install_id: policy.installId },
      {
        // The install token identifies this exact install, unlike the device-wide API key.
        headers: {
          Authorization: `Bearer ${installToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
  }
}
