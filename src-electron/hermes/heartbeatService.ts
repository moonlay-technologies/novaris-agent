import axios from 'axios';
import { getLogger } from '../../dist/utils/logger';
import { LockedHermesPolicy } from './runtimePolicy';

/** Periodically proves that the managed Hermes install is still alive. */
export class HermesHeartbeatService {
  private readonly logger = getLogger();
  private timer: NodeJS.Timeout | null = null;

  start(apiUrl: string, apiKey: string, policy: LockedHermesPolicy): void {
    this.stop();
    const send = () => {
      this.sendHeartbeat(apiUrl, apiKey, policy).catch((error) => {
        this.logger.warn('Hermes heartbeat failed', { error });
      });
    };

    send();
    this.timer = setInterval(send, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sendHeartbeat(apiUrl: string, apiKey: string, policy: LockedHermesPolicy): Promise<void> {
    await axios.post(
      `${apiUrl.replace(/\/$/, '')}/hermes-installs/heartbeat`,
      { install_id: policy.installId },
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
  }
}
