import { execFile, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getLogger } from '../../dist/utils/logger';

export type HermesGatewayPlatform = 'telegram' | 'discord' | 'slack' | 'whatsapp';

export interface HermesGatewayPlatformConfig {
  enabled: boolean;
  token?: string;
  api_key?: string;
  home_channel?: string;
  [key: string]: unknown;
}

export interface HermesGatewayConfig {
  platforms: Partial<Record<HermesGatewayPlatform, HermesGatewayPlatformConfig>>;
  streaming?: boolean;
  default_reset_policy?: string;
  [key: string]: unknown;
}

export interface HermesGatewayStatus {
  configured: HermesGatewayPlatform[];
  running: boolean;
  output: string;
  hermesHome: string;
}

export interface HermesGatewaySaveResult {
  success: boolean;
  configured: HermesGatewayPlatform[];
  hermesHome: string;
}

const SENSITIVE_KEYS = new Set(['token', 'api_key', 'secret', 'password', 'access_token']);

/** Manages the user's local Hermes gateway without exposing shell or filesystem access to the renderer. */
export class HermesGatewayService {
  private readonly logger = getLogger();
  private readonly gatewayProcesses = new Set<ChildProcess>();

  getConfig(): HermesGatewayConfig {
    const configPath = this.getPrimaryConfigPath();
    if (!fs.existsSync(configPath)) {
      return this.redactConfig(this.readLegacyConfig());
    }

    try {
      const parsed = parseYaml(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      return this.redactConfig(this.toGatewayConfig(parsed));
    } catch (error) {
      this.logger.warn('Unable to read Hermes gateway configuration', { error });
      return { platforms: {} };
    }
  }

  async saveConfig(config: HermesGatewayConfig): Promise<HermesGatewaySaveResult> {
    const validated = this.validateConfig(config);
    const current = this.readRawConfig();
    const merged = this.mergeConfig(current, validated);
    const configPath = this.getPrimaryConfigPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    this.backupConfig(configPath);
    const temporaryPath = `${configPath}.tmp`;
    const document = this.mergePlatformConfig(this.readYamlConfig(), merged);
    fs.writeFileSync(temporaryPath, `${stringifyYaml(document)}`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);

    this.logger.info('Hermes gateway configuration saved', {
      platforms: this.getConfiguredPlatforms(merged),
      hermesHome: this.getHermesHome(),
    });

    return {
      success: true,
      configured: this.getConfiguredPlatforms(merged),
      hermesHome: this.getHermesHome(),
    };
  }

  async status(): Promise<HermesGatewayStatus> {
    const config = this.readRawConfig();
    const result = await this.runHermes(['gateway', 'status']);
    return {
      configured: this.getConfiguredPlatforms(config),
      running: result.code === 0 && !/not running|stopped|inactive|failed/i.test(result.output),
      output: this.redactText(result.output),
      hermesHome: this.getHermesHome(),
    };
  }

  async start(): Promise<{ success: boolean; message: string }> {
    const result = await this.runHermes(['gateway', 'start']);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    const result = await this.runHermes(['gateway', 'stop']);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  async restart(): Promise<{ success: boolean; message: string }> {
    const result = await this.runHermes(['gateway', 'restart']);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  async pairingList(): Promise<{ success: boolean; message: string }> {
    const result = await this.runHermes(['pairing', 'list']);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  async pairingPending(): Promise<{ success: boolean; message: string }> {
    return this.pairingList();
  }

  async approvePairing(platform: HermesGatewayPlatform, code: string): Promise<{ success: boolean; message: string }> {
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/i.test(code)) {
      throw new Error('Pairing code must contain exactly 8 letters or numbers');
    }
    const result = await this.runHermes(['pairing', 'approve', platform, code]);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  async revokePairing(platform: HermesGatewayPlatform, userId: string): Promise<{ success: boolean; message: string }> {
    if (!userId || userId.length > 200) throw new Error('Invalid pairing user ID');
    const result = await this.runHermes(['pairing', 'revoke', platform, userId]);
    return { success: result.code === 0, message: this.redactText(result.output) };
  }

  dispose(): void {
    for (const child of this.gatewayProcesses) {
      child.kill();
    }
    this.gatewayProcesses.clear();
  }

  private validateConfig(config: HermesGatewayConfig): HermesGatewayConfig {
    if (!config || typeof config !== 'object' || !config.platforms || typeof config.platforms !== 'object') {
      throw new Error('Gateway configuration must include a platforms object');
    }

    for (const [platform, value] of Object.entries(config.platforms)) {
      if (!['telegram', 'discord', 'slack', 'whatsapp'].includes(platform)) {
        throw new Error(`Unsupported gateway platform: ${platform}`);
      }
      if (!value || typeof value !== 'object') {
        throw new Error(`Invalid configuration for ${platform}`);
      }
    }

    return config;
  }

  private mergeConfig(current: HermesGatewayConfig, incoming: HermesGatewayConfig): HermesGatewayConfig {
    const platforms = { ...(current.platforms || {}) };
    for (const [platform, value] of Object.entries(incoming.platforms)) {
      if (!value) continue;
      const previous = platforms[platform as HermesGatewayPlatform] || {};
      platforms[platform as HermesGatewayPlatform] = {
        ...previous,
        ...value,
        ...this.restoreRedactedSecrets(value, previous),
      };
    }
    return { ...current, ...incoming, platforms };
  }

  private restoreRedactedSecrets(incoming: HermesGatewayPlatformConfig, previous: Partial<HermesGatewayPlatformConfig>): Partial<HermesGatewayPlatformConfig> {
    const restored: Partial<HermesGatewayPlatformConfig> = {};
    for (const key of SENSITIVE_KEYS) {
      if (incoming[key] === '********' && previous[key]) restored[key] = previous[key];
    }
    return restored;
  }

  private readRawConfig(): HermesGatewayConfig {
    const yamlConfig = this.readYamlConfig();
    if (Object.keys(yamlConfig).length > 0) return this.toGatewayConfig(yamlConfig);
    return this.readLegacyConfig();
  }

  private readYamlConfig(): Record<string, unknown> {
    const configPath = this.getPrimaryConfigPath();
    if (!fs.existsSync(configPath)) return {};
    try {
      const parsed = parseYaml(fs.readFileSync(configPath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch (_error) {
      return {};
    }
  }

  private readLegacyConfig(): HermesGatewayConfig {
    const configPath = this.getLegacyConfigPath();
    if (!fs.existsSync(configPath)) return { platforms: {} };
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as HermesGatewayConfig;
    } catch (_error) {
      return { platforms: {} };
    }
  }

  private toGatewayConfig(source: Record<string, unknown>): HermesGatewayConfig {
    const sourcePlatforms = (source.platforms && typeof source.platforms === 'object')
      ? source.platforms as Record<string, HermesGatewayPlatformConfig>
      : {};
    const platforms: Partial<Record<HermesGatewayPlatform, HermesGatewayPlatformConfig>> = {};
    for (const platform of ['telegram', 'discord', 'slack', 'whatsapp'] as HermesGatewayPlatform[]) {
      const value = sourcePlatforms[platform] || source[platform];
      if (value && typeof value === 'object') platforms[platform] = value as HermesGatewayPlatformConfig;
    }
    return {
      ...source,
      platforms,
      default_reset_policy: typeof source.default_reset_policy === 'string' ? source.default_reset_policy : undefined,
    };
  }

  private mergePlatformConfig(source: Record<string, unknown>, config: HermesGatewayConfig): Record<string, unknown> {
    const result = { ...source };
    const existingPlatforms = result.platforms && typeof result.platforms === 'object'
      ? result.platforms as Record<string, unknown>
      : {};
    const mergedPlatforms: Record<string, unknown> = { ...existingPlatforms };
    result.platforms = mergedPlatforms;

    for (const [platform, incoming] of Object.entries(config.platforms)) {
      if (!incoming) continue;
      const existing = existingPlatforms[platform] && typeof existingPlatforms[platform] === 'object'
        ? existingPlatforms[platform] as Record<string, unknown>
        : {};
      mergedPlatforms[platform] = { ...existing, ...incoming };
    }
    return result;
  }

  private backupConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) return;
    const backupPath = `${configPath}.novaris.backup`;
    fs.copyFileSync(configPath, backupPath);
  }

  private redactConfig(config: HermesGatewayConfig): HermesGatewayConfig {
    const copy = JSON.parse(JSON.stringify(config)) as HermesGatewayConfig;
    for (const platform of Object.values(copy.platforms || {})) {
      if (!platform) continue;
      for (const key of SENSITIVE_KEYS) {
        if (typeof platform[key] === 'string' && platform[key]) platform[key] = '********';
      }
    }
    return copy;
  }

  private getConfiguredPlatforms(config: HermesGatewayConfig): HermesGatewayPlatform[] {
    return Object.entries(config.platforms || {})
      .filter(([, value]) => value?.enabled === true)
      .map(([platform]) => platform as HermesGatewayPlatform);
  }

  private getHermesHome(): string {
    return process.env.HERMES_HOME || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes'));
  }

  private getPrimaryConfigPath(): string {
    return path.join(this.getHermesHome(), 'config.yaml');
  }

  private getLegacyConfigPath(): string {
    return path.join(this.getHermesHome(), 'gateway.json');
  }

  private resolveExecutable(): string {
    if (process.env.HERMES_EXECUTABLE_PATH) return process.env.HERMES_EXECUTABLE_PATH;
    return process.platform === 'win32' ? 'hermes.cmd' : 'hermes';
  }

  private runHermes(args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = execFile(this.resolveExecutable(), args, {
        cwd: this.getHermesHome(),
        env: { ...process.env, HERMES_HOME: this.getHermesHome() },
        timeout: 30000,
        windowsHide: true,
        shell: process.platform === 'win32',
      }, (error, stdout, stderr) => {
        this.gatewayProcesses.delete(child);
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout || ''}${stderr || ''}`.trim() });
      });
      this.gatewayProcesses.add(child);
    });
  }

  private redactText(value: string): string {
    return value.replace(/(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,}]+/gi, '$1=********');
  }
}
