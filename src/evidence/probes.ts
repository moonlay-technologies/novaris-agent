import { CommandResult } from '../utils/commandRunner';
import { EvidenceContext } from './evidencePack';

export type ProbeFailure = Extract<CommandResult, { ok: false }> | { ok: false; reason: 'parse_error'; exitCode: null; stdout: string; stderr: string; error: string };
export type JsonProbe<T> = { ok: true; data: T } | ProbeFailure;

/**
 * Runs a PowerShell script that writes one JSON document to stdout. Built-in
 * Windows tooling only (no modules to install); never throws.
 */
export async function runPowerShellJson<T>(context: EvidenceContext, script: string, timeoutMs = 60000): Promise<JsonProbe<T>> {
  const result = await context.runner.run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs },
  );
  if (!result.ok) return result;
  return parseJson<T>(result.stdout);
}

export function parseJson<T>(stdout: string): JsonProbe<T> {
  const text = stdout.trim();
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, reason: 'parse_error', exitCode: null, stdout: '', stderr: '', error: 'output was not valid JSON' };
  }
}

/** Runs a command where a non-zero exit code can still carry a valid answer (e.g. dnf check-update exits 100). */
export async function runAccepting(
  context: EvidenceContext,
  file: string,
  args: string[],
  acceptedExitCodes: number[],
  timeoutMs = 60000,
): Promise<CommandResult> {
  const result = await context.runner.run(file, args, { timeoutMs });
  if (!result.ok && result.reason === 'command_failed' && result.exitCode !== null && acceptedExitCodes.includes(result.exitCode)) {
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }
  return result;
}

export function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86400000));
}

/** Parses a date the way PowerShell's ConvertTo-Json writes it ("/Date(1729500000000)/") or ISO text. */
export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  const msDate = text.match(/\/Date\((-?\d+)/);
  const date = msDate ? new Date(Number(msDate[1])) : new Date(text);
  return Number.isNaN(date.getTime()) || date.getFullYear() < 2000 ? null : date;
}

export function toBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return null;
}

export function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}
