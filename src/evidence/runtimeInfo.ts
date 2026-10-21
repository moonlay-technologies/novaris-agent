import { createHash } from 'crypto';
import { AgentConfig } from '../types/config';
import { RunMode } from '../types/evidence';
import { CommandRunner } from '../utils/commandRunner';

/**
 * The boot-time service runs the compiled agent under plain Node; the desktop
 * app runs it inside Electron as the signed-in user.
 */
export function detectRunMode(): RunMode {
  return process.versions.electron ? 'desktop' : 'service';
}

/** Whether the agent runs as SYSTEM/Administrator (Windows) or root (macOS/Linux). */
export async function detectElevated(runner: CommandRunner): Promise<boolean> {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }
  // "net session" only succeeds for members of the Administrators group (including SYSTEM)
  const result = await runner.run('net', ['session'], { timeoutMs: 10000 });
  return result.ok;
}

/** Settings that are secret, device-specific or change on their own: excluded from the config hash. */
const VOLATILE_KEYS: ReadonlyArray<keyof AgentConfig> = [
  'apiKey',
  'deviceId',
  'logsCursor',
  'knownNetworkDevices',
  'autoStartUserManaged',
  'snmpCommunity',
];

/** Fingerprint of the collection-relevant configuration, to spot devices running non-standard settings. */
export function configHash(config: AgentConfig): string {
  const relevant: Record<string, unknown> = {};
  for (const key of Object.keys(config).sort()) {
    if (!VOLATILE_KEYS.includes(key as keyof AgentConfig)) {
      relevant[key] = (config as unknown as Record<string, unknown>)[key];
    }
  }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}
