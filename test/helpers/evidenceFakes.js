// Test doubles for the evidence packs: recorded command output and osquery rows,
// so packs can be tested on any machine without touching the real OS.

/** Replays outputs keyed by "file arg1 arg2". Unknown commands behave as not installed. */
class FakeRunner {
  constructor(outputs = {}) {
    this.outputs = outputs;
    this.calls = [];
  }

  async run(file, args = []) {
    const key = [file, ...args].join(' ');
    this.calls.push(key);
    // A function registered under the program name answers any arguments (used for PowerShell scripts)
    const entry = this.outputs[key] ?? (typeof this.outputs[file] === 'function' ? this.outputs[file](args) : undefined);
    if (entry === undefined) {
      return { ok: false, reason: 'tool_unavailable', exitCode: null, stdout: '', stderr: '', error: `${file} not found` };
    }
    if (typeof entry === 'string') {
      return { ok: true, stdout: entry, stderr: '' };
    }
    return entry; // full CommandResult
  }
}

/** Answers queries whose SQL contains a registered table name. */
class FakeOsquery {
  constructor(tables = {}, { available = true, version = '5.23.1' } = {}) {
    this.tables = tables;
    this.isAvailable = available;
    this.ver = version;
    this.queries = [];
  }

  available() {
    return this.isAvailable;
  }

  async version() {
    return this.isAvailable ? this.ver : null;
  }

  async query(sql) {
    this.queries.push(sql);
    if (!this.isAvailable) return { ok: false, reason: 'tool_unavailable', error: 'osquery binary not bundled' };
    // Longest table name first, so "users" does not shadow "user_groups"
    const names = Object.keys(this.tables).sort((a, b) => b.length - a.length);
    const match = names.find((name) => new RegExp(`\\b${name}\\b`).test(sql));
    if (!match) return { ok: true, rows: [] };
    const entry = this.tables[match];
    if (typeof entry === 'function') return entry(sql);
    if (entry && entry.ok === false) return entry;
    return { ok: true, rows: entry };
  }
}

/** In-memory files: { path: { text?, mtime? } }; directories are derived from the paths. */
class FakeFiles {
  constructor(files = {}) {
    this.files = files;
  }

  async readText(filePath) {
    return this.files[filePath]?.text ?? null;
  }

  async modifiedAt(filePath) {
    const mtime = this.files[filePath]?.mtime;
    return mtime ? new Date(mtime) : null;
  }

  async exists(filePath) {
    return filePath in this.files || Object.keys(this.files).some((p) => p.startsWith(`${filePath}/`));
  }

  async list(dirPath) {
    const children = new Set();
    for (const p of Object.keys(this.files)) {
      if (!p.startsWith(`${dirPath}/`)) continue;
      children.add(`${dirPath}/${p.slice(dirPath.length + 1).split('/')[0]}`);
    }
    return Array.from(children);
  }
}

function context(overrides = {}) {
  return {
    platform: 'windows',
    runMode: 'service',
    elevated: true,
    runner: new FakeRunner(),
    osquery: new FakeOsquery(),
    files: new FakeFiles(),
    now: () => new Date('2026-10-21T08:00:00Z'),
    uptimeSeconds: () => 86400,
    ...overrides,
  };
}

/** Keys that must never appear anywhere in an evidence payload. */
const FORBIDDEN_KEYS = ['command', 'cmdline', 'ssid', 'bssid', 'password', 'recovery_key', 'recovery_password', 'key_protector', 'token'];

function findForbiddenKeys(value, path = '$') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findForbiddenKeys(item, `${path}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase())) found.push(`${path}.${key}`);
      found.push(...findForbiddenKeys(child, `${path}.${key}`));
    }
  }
  return found;
}

module.exports = { FakeRunner, FakeOsquery, FakeFiles, context, findForbiddenKeys };
