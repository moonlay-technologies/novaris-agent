/**
 * Anti-malware / EDR products recognised by their running process (macOS,
 * Linux) or registration name (Windows). Detection is by name only: the agent
 * never reads product configuration or content.
 */
export interface KnownProduct {
  name: string;
  kind: 'av' | 'edr';
  /** Process names that indicate the product's real-time engine is running. */
  processes: string[];
}

export const MAC_PRODUCTS: KnownProduct[] = [
  { name: 'CrowdStrike Falcon', kind: 'edr', processes: ['com.crowdstrike.falcon.Agent', 'falcond'] },
  { name: 'SentinelOne', kind: 'edr', processes: ['sentineld', 'SentinelAgent'] },
  { name: 'Microsoft Defender for Endpoint', kind: 'edr', processes: ['wdavdaemon', 'wdavdaemon_enterprise'] },
  { name: 'Sophos', kind: 'av', processes: ['SophosScanD', 'SophosAntiVirus'] },
  { name: 'Trend Micro', kind: 'av', processes: ['iCoreService', 'TmccMac'] },
  { name: 'ESET', kind: 'av', processes: ['esets_daemon', 'esets_proxy'] },
  { name: 'Bitdefender', kind: 'av', processes: ['BDLDaemon', 'bdservicehost'] },
  { name: 'Jamf Protect', kind: 'edr', processes: ['JamfProtect'] },
];

export const LINUX_PRODUCTS: KnownProduct[] = [
  { name: 'CrowdStrike Falcon', kind: 'edr', processes: ['falcon-sensor'] },
  { name: 'SentinelOne', kind: 'edr', processes: ['s1-agent', 'sentinelone'] },
  { name: 'Microsoft Defender for Endpoint', kind: 'edr', processes: ['wdavdaemon'] },
  { name: 'Sophos', kind: 'av', processes: ['sophos-spl', 'savd'] },
  { name: 'Trend Micro', kind: 'av', processes: ['ds_agent'] },
  { name: 'ESET', kind: 'av', processes: ['esets_daemon', 'oaeventd'] },
  { name: 'Elastic Defend', kind: 'edr', processes: ['elastic-endpoint'] },
  { name: 'Wazuh', kind: 'edr', processes: ['wazuh-agentd'] },
  { name: 'ClamAV', kind: 'av', processes: ['clamd', 'clamonacc'] },
];

/** Windows Security Center names that are EDR rather than classic AV. */
const WINDOWS_EDR_PATTERN = /crowdstrike|sentinel\s*one|sentinelone|cortex|carbon\s*black|cybereason|defender for endpoint|elastic/i;

export function windowsProductKind(name: string): 'av' | 'edr' {
  return WINDOWS_EDR_PATTERN.test(name) ? 'edr' : 'av';
}
