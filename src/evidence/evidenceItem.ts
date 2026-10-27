import * as os from 'os';
import { CommandResult } from '../utils/commandRunner';
import { OsqueryResult } from '../utils/osquery';
import { EvidenceItem, EvidencePlatform, EvidenceReason } from '../types/evidence';

/** Builders for evidence items, so every pack reports status the same way. */

export function ok<T>(source: string, value: T): EvidenceItem<T> {
  return { status: 'ok', reason: null, source, error: null, value };
}

export function unknown<T>(source: string, reason: EvidenceReason, error: string | null = null): EvidenceItem<T> {
  return { status: 'unknown', reason, source, error, value: null };
}

export function failed<T>(source: string, reason: EvidenceReason, error: string | null): EvidenceItem<T> {
  return { status: 'error', reason, source, error, value: null };
}

export function notApplicable<T>(source: string, reason: EvidenceReason = 'unsupported_platform'): EvidenceItem<T> {
  return { status: 'not_applicable', reason, source, error: null, value: null };
}

/**
 * Turns a failed osquery/command outcome into an evidence item:
 * a missing tool or missing privilege is "unknown" (could not check), anything
 * else is "error" (tried and failed).
 */
export function fromFailure<T>(
  source: string,
  result: Extract<OsqueryResult<unknown>, { ok: false }> | Extract<CommandResult, { ok: false }>,
  elevated: boolean,
): EvidenceItem<T> {
  if (result.reason === 'tool_unavailable') {
    return unknown(source, 'tool_unavailable', result.error);
  }
  if (!elevated && result.reason === 'command_failed') {
    return unknown(source, 'insufficient_privilege', result.error);
  }
  return failed(source, result.reason, result.error);
}

/** Wraps an unexpected exception from a probe as an error item. */
export function fromException<T>(source: string, error: unknown): EvidenceItem<T> {
  const message = error instanceof Error ? error.message : String(error);
  return failed(source, 'command_failed', message.split(/\r?\n/)[0].slice(0, 200));
}

export function currentPlatform(): EvidencePlatform | null {
  switch (os.platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

/** Placeholder serials that firmware vendors ship instead of a real one. */
const PLACEHOLDER_VALUES = new Set([
  '',
  '0',
  'none',
  'n/a',
  'na',
  'default string',
  'to be filled by o.e.m.',
  'system serial number',
  'not specified',
  'not applicable',
  '0123456789',
  'unknown',
]);

/** Trims a hardware string and maps vendor placeholders to null. */
export function cleanHardwareString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return PLACEHOLDER_VALUES.has(text.toLowerCase()) ? null : text.slice(0, 255);
}
