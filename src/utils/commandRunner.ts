import { execFile } from 'child_process';

/** Outcome of running an external command, without throwing. */
export type CommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: 'tool_unavailable' | 'timeout' | 'command_failed'; exitCode: number | null; stdout: string; stderr: string; error: string };

export interface CommandOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/**
 * Runs a program directly (no shell), so arguments are never interpreted by a
 * shell. Evidence packs depend on this interface rather than child_process, so
 * tests can replay recorded outputs.
 */
export interface CommandRunner {
  run(file: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

/** Short, single-line diagnostic: never the full output, which may contain user data. */
function shortError(message: string): string {
  return message.split(/\r?\n/)[0].slice(0, 200);
}

export class ExecFileCommandRunner implements CommandRunner {
  run(file: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');
          if (!error) {
            resolve({ ok: true, stdout: out, stderr: err });
            return;
          }

          const code = (error as NodeJS.ErrnoException).code;
          const killed = (error as { killed?: boolean }).killed;
          const exitCode = typeof code === 'number' ? code : null;
          if (code === 'ENOENT') {
            resolve({ ok: false, reason: 'tool_unavailable', exitCode: null, stdout: out, stderr: err, error: `${file} not found` });
          } else if (killed) {
            resolve({ ok: false, reason: 'timeout', exitCode, stdout: out, stderr: err, error: `${file} timed out` });
          } else {
            resolve({ ok: false, reason: 'command_failed', exitCode, stdout: out, stderr: err, error: shortError(error.message) });
          }
        },
      );
    });
  }
}
