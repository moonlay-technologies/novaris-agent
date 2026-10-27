import { promises as fs } from 'fs';
import * as path from 'path';

/** Read-only file access as evidence packs see it (replaceable in tests). Never throws. */
export interface FileReader {
  readText(filePath: string, maxBytes?: number): Promise<string | null>;
  modifiedAt(filePath: string): Promise<Date | null>;
  exists(filePath: string): Promise<boolean>;
  list(dirPath: string): Promise<string[]>;
}

export const localFiles: FileReader = {
  async readText(filePath, maxBytes = 1024 * 1024) {
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const { size } = await handle.stat();
        // Large logs: only the tail is relevant (latest entries)
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer.toString('utf-8');
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  },
  async modifiedAt(filePath) {
    try {
      return (await fs.stat(filePath)).mtime;
    } catch {
      return null;
    }
  },
  async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  async list(dirPath) {
    try {
      return (await fs.readdir(dirPath)).map((name) => path.join(dirPath, name));
    } catch {
      return [];
    }
  },
};
