import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Keeps the install token encrypted with the OS keychain (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux) so the runtime can restart after the
 * app restarts without asking for a new install code. Without OS encryption
 * the token is kept in memory only.
 */
export class InstallTokenStore {
  constructor(private readonly filePath: string) {}

  save(token: string): boolean {
    if (!safeStorage.isEncryptionAvailable()) {
      this.clear();
      return false;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, safeStorage.encryptString(token), { mode: 0o600 });
    return true;
  }

  load(): string | null {
    if (!fs.existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      return safeStorage.decryptString(fs.readFileSync(this.filePath));
    } catch {
      return null;
    }
  }

  clear(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}
