import * as snmp from 'net-snmp';
import { SecurityEvent } from '../types/device';
import { buildSecurityEventId } from '../utils/securityEventClassifier';
import { getLogger } from '../utils/logger';

const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const OID_SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0';

const SESSION_TIMEOUT_MS = 5000;

export interface SnmpTargetStatus {
  target: string;
  reachable: boolean;
  sysName: string | null;
  sysDescr: string | null;
  sysUptimeTicks: number | null;
}

function pollTarget(target: string, community: string): Promise<SnmpTargetStatus> {
  return new Promise((resolve) => {
    const session = snmp.createSession(target, community, { timeout: SESSION_TIMEOUT_MS, retries: 0 });

    const finish = (status: SnmpTargetStatus) => {
      session.close();
      resolve(status);
    };

    session.get([OID_SYS_NAME, OID_SYS_DESCR, OID_SYS_UPTIME], (error, varbinds) => {
      if (error || !varbinds) {
        finish({ target, reachable: false, sysName: null, sysDescr: null, sysUptimeTicks: null });
        return;
      }

      const hasError = varbinds.some((vb) => snmp.isVarbindError(vb));
      if (hasError) {
        finish({ target, reachable: false, sysName: null, sysDescr: null, sysUptimeTicks: null });
        return;
      }

      finish({
        target,
        reachable: true,
        sysName: varbinds[0]?.value?.toString() ?? null,
        sysDescr: varbinds[1]?.value?.toString() ?? null,
        sysUptimeTicks: typeof varbinds[2]?.value === 'number' ? varbinds[2].value : null,
      });
    });

    session.on('error', () => {
      finish({ target, reachable: false, sysName: null, sysDescr: null, sysUptimeTicks: null });
    });
  });
}

/**
 * Polls a configured list of SNMP-capable devices (switches, APs, printers, etc.)
 * for basic identity/liveness data. Never throws on an unreachable target - a
 * timeout/error just means "not reachable this cycle", not a scan failure.
 */
export class SnmpCollector {
  private logger = getLogger();
  private lastReachable = new Map<string, boolean>();

  async collect(targets: string[], community: string): Promise<{ statuses: SnmpTargetStatus[]; events: SecurityEvent[] }> {
    const statuses: SnmpTargetStatus[] = [];
    const events: SecurityEvent[] = [];
    const now = new Date();

    for (const target of targets) {
      let status: SnmpTargetStatus;
      try {
        status = await pollTarget(target, community);
      } catch (error: any) {
        this.logger.warn('SNMP poll failed unexpectedly', { target, error: error?.message || error });
        status = { target, reachable: false, sysName: null, sysDescr: null, sysUptimeTicks: null };
      }
      statuses.push(status);

      const wasReachable = this.lastReachable.get(target);
      if (wasReachable !== undefined && wasReachable !== status.reachable) {
        const eventType = status.reachable ? 'network_device_recovered' : 'network_device_unreachable';
        const message = status.reachable
          ? `SNMP device ${target} (${status.sysName || 'unknown'}) is reachable again`
          : `SNMP device ${target} became unreachable`;

        events.push({
          eventId: buildSecurityEventId(eventType, `snmp:${target}`, 'warning', now, message),
          eventType,
          severity: 'warning',
          source: `snmp:${target}`,
          message,
          collectedAt: now,
          payload: { sysName: status.sysName, sysDescr: status.sysDescr },
        });
      }
      this.lastReachable.set(target, status.reachable);
    }

    return { statuses, events };
  }
}
