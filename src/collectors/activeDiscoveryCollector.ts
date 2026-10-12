import * as si from 'systeminformation';
import { SecurityEvent } from '../types/device';
import { buildSecurityEventId } from '../utils/securityEventClassifier';
import { getArpTable, pingSweep } from '../utils/arpTable';
import { getLogger } from '../utils/logger';

export interface ActiveDiscoveryResult {
  knownDevices: string[];
  events: SecurityEvent[];
}

/**
 * Discovers devices on the local subnet: pings the /24 range to populate the OS
 * ARP cache, reads it back, and diffs the seen MACs against a persisted known-device
 * list. A MAC not seen before produces a `SecurityEvent` (rogue/unrecognized device
 * on the network, DE.CM-01). Never throws - a subnet detection or sweep failure just
 * means an empty result for this cycle.
 */
export class ActiveDiscoveryCollector {
  private logger = getLogger();

  async collect(knownDevices: string[]): Promise<ActiveDiscoveryResult> {
    try {
      const defaultIface = await si.networkInterfaces('default');
      if (!defaultIface?.ip4) {
        this.logger.debug('Active discovery skipped: no default network interface with an IPv4 address');
        return { knownDevices, events: [] };
      }

      await pingSweep(defaultIface.ip4);
      const arpEntries = await getArpTable();

      const knownSet = new Set(knownDevices);
      const seenMacs = new Set<string>();
      const events: SecurityEvent[] = [];
      const now = new Date();

      for (const entry of arpEntries) {
        if (!entry.mac || entry.mac === defaultIface.mac?.toLowerCase()) {
          continue;
        }
        seenMacs.add(entry.mac);

        if (!knownSet.has(entry.mac)) {
          const message = `New device detected on network: ${entry.ip} (${entry.mac})`;
          events.push({
            eventId: buildSecurityEventId('network_device_discovered', 'network-discovery', 'warning', now, message),
            eventType: 'network_device_discovered',
            severity: 'warning',
            source: 'network-discovery',
            message,
            collectedAt: now,
            payload: { ip: entry.ip, mac: entry.mac },
          });
          knownSet.add(entry.mac);
        }
      }

      return { knownDevices: Array.from(knownSet), events };
    } catch (error: any) {
      this.logger.warn('Active discovery failed', { error: error?.message || error });
      return { knownDevices, events: [] };
    }
  }
}
