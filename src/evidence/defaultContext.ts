import * as os from 'os';
import { EvidenceContext } from './evidencePack';
import { currentPlatform } from './evidenceItem';
import { detectElevated, detectRunMode } from './runtimeInfo';
import { ExecFileCommandRunner } from '../utils/commandRunner';
import { localFiles } from '../utils/fileReader';
import { bundledOsquery } from '../utils/osquery';

let cached: Promise<EvidenceContext | null> | null = null;

/**
 * The real-machine context, built once: detecting elevation runs a command.
 * Resolves to null on platforms the evidence packs do not support.
 */
export function getDefaultEvidenceContext(): Promise<EvidenceContext | null> {
  if (!cached) {
    cached = (async () => {
      const platform = currentPlatform();
      if (!platform) return null;
      const runner = new ExecFileCommandRunner();
      return {
        platform,
        runMode: detectRunMode(),
        elevated: await detectElevated(runner),
        runner,
        osquery: bundledOsquery,
        files: localFiles,
        now: () => new Date(),
        uptimeSeconds: () => Math.floor(os.uptime()),
      };
    })();
  }
  return cached;
}
