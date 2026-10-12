import { exec } from 'child_process';
import { promisify } from 'util';
import * as si from 'systeminformation';

const execAsync = promisify(exec);

export interface ArpEntry {
  ip: string;
  mac: string;
}

function parseWindowsArp(output: string): ArpEntry[] {
  const entries: ArpEntry[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+([0-9a-fA-F-]{17})\s+(\w+)/);
    if (!match) continue;
    entries.push({ ip: match[1], mac: match[2].toLowerCase().replace(/-/g, ':') });
  }
  return entries;
}

function parseIpNeigh(output: string): ArpEntry[] {
  const entries: ArpEntry[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+dev\s+(\S+)\s+lladdr\s+([0-9a-fA-F:]{17})\s+(\S+)/);
    if (!match) continue;
    const state = match[4].toLowerCase();
    if (state === 'failed') continue;
    entries.push({ ip: match[1], mac: match[3].toLowerCase() });
  }
  return entries;
}

function parseUnixArp(output: string): ArpEntry[] {
  const entries: ArpEntry[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/\(([^)]+)\)\s+at\s+([0-9a-fA-F:]{17})/);
    if (!match) continue;
    entries.push({ ip: match[1], mac: match[2].toLowerCase() });
  }
  return entries;
}

/** Reads the OS's ARP/neighbor cache. Returns an empty array on any failure - never throws. */
export async function getArpTable(): Promise<ArpEntry[]> {
  try {
    const osInfo = await si.osInfo();
    const platform = (osInfo.platform || '').toLowerCase();

    if (platform.includes('win')) {
      const { stdout } = await execAsync('arp -a', { maxBuffer: 5 * 1024 * 1024 });
      return parseWindowsArp(stdout);
    }

    try {
      const { stdout } = await execAsync('ip neigh', { maxBuffer: 5 * 1024 * 1024 });
      return parseIpNeigh(stdout);
    } catch {
      const { stdout } = await execAsync('arp -a', { maxBuffer: 5 * 1024 * 1024 });
      return parseUnixArp(stdout);
    }
  } catch {
    return [];
  }
}

function pingCommand(ip: string): string {
  return process.platform === 'win32' ? `ping -n 1 -w 200 ${ip}` : `ping -c 1 -W 1 ${ip}`;
}

/** Best-effort ping sweep to populate the OS ARP cache before reading it. Ignores individual ping failures. */
export async function pingSweep(subnetBaseIp: string, concurrency = 32): Promise<void> {
  const parts = subnetBaseIp.split('.');
  if (parts.length !== 4) {
    return;
  }
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);

  for (let i = 0; i < hosts.length; i += concurrency) {
    const batch = hosts.slice(i, i + concurrency);
    await Promise.all(
      batch.map((ip) =>
        execAsync(pingCommand(ip)).catch(() => {
          /* unreachable host - expected for most of the sweep */
        })
      )
    );
  }
}
