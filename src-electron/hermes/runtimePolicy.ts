import * as fs from 'fs';
import * as path from 'path';
import { HermesBootstrapPayload } from '../../dist/types/hermes';

export interface LockedHermesPolicy {
  installId: number;
  backendBaseUrl: string;
  proxyEndpointUrl: string;
  policyVersion: string;
  allowedTools: string[];
  workspacePath: string;
  installToken: string | null;
}

/** Builds and validates the local policy used by the managed Hermes process. */
export class HermesRuntimePolicy {
  static fromBootstrap(payload: HermesBootstrapPayload): LockedHermesPolicy {
    const backendUrl = new URL(payload.backendBaseUrl);
    const proxyUrl = new URL(payload.proxyEndpointUrl);

    if (backendUrl.protocol !== 'https:' && backendUrl.hostname !== 'localhost' && backendUrl.hostname !== '127.0.0.1') {
      throw new Error('Hermes backend URL must use HTTPS outside local development');
    }

    if (proxyUrl.protocol !== backendUrl.protocol || proxyUrl.host !== backendUrl.host) {
      throw new Error('Hermes proxy endpoint must belong to the configured Novaris backend');
    }

    if (!payload.policyVersion || payload.allowedTools.some((tool) => !/^[a-z0-9_-]+$/i.test(tool))) {
      throw new Error('Hermes bootstrap contains an invalid runtime policy');
    }

    const workspacePath = HermesRuntimePolicy.resolveWorkspacePath(payload.workspacePathRule);

    return {
      installId: payload.installId,
      backendBaseUrl: backendUrl.toString().replace(/\/$/, ''),
      proxyEndpointUrl: proxyUrl.toString(),
      policyVersion: payload.policyVersion,
      allowedTools: [...payload.allowedTools],
      workspacePath,
      installToken: payload.installToken,
    };
  }

  static write(policy: LockedHermesPolicy, filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  static read(filePath: string): LockedHermesPolicy {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LockedHermesPolicy;
    if (!parsed.installId || !parsed.proxyEndpointUrl || !parsed.policyVersion || !parsed.workspacePath) {
      throw new Error('Stored Hermes runtime policy is incomplete');
    }
    return parsed;
  }

  private static resolveWorkspacePath(rule: string): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const normalizedRule = rule.trim();

    if (!normalizedRule || normalizedRule === ':workspace') {
      return path.join(home, 'AssetAssistant');
    }

    if (path.isAbsolute(normalizedRule)) {
      const resolved = path.resolve(normalizedRule);
      const homeResolved = path.resolve(home);
      if (resolved !== homeResolved && !resolved.startsWith(`${homeResolved}${path.sep}`)) {
        throw new Error('Hermes workspace must be inside the current user profile');
      }
      return resolved;
    }

    return path.resolve(home, normalizedRule.replace(/^[:/\\]+/, ''));
  }
}
