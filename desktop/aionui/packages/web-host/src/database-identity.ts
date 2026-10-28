const PREFIX = '\x1eAIONCORE_DB_IDENTITY_V1 ';
const REASONS = [
  'unsupported_platform',
  'connection_unavailable',
  'lock_timeout',
  'sqlite_handle_unavailable',
  'file_identity_unavailable',
];
const KEYS = [
  'v',
  'pid',
  'generation',
  'phase',
  'ordinal',
  'status',
  'fingerprint',
  'reason',
  'sqliteCode',
  'win32Code',
];

export type IdentityRecord = {
  v: 1;
  pid: number;
  generation: string;
  phase: 'bootstrap' | 'business';
  ordinal: 0 | 1;
  status: 'identified' | 'unavailable';
  fingerprint: string | null;
  reason: string | null;
  sqliteCode: number | null;
  win32Code: number | null;
};

function parseRecord(line: Buffer, pid: number): IdentityRecord | null {
  if (line.length + 1 > 1024) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    return null;
  }
  if (!text.startsWith(PREFIX)) return null;
  const payload = text.slice(PREFIX.length);
  try {
    const keys = Array.from(payload.matchAll(/"(?:\\.|[^"\\])*"(?=\s*:)/g), (m) => JSON.parse(m[0]) as string);
    if (keys.length !== KEYS.length || new Set(keys).size !== KEYS.length || keys.some((key) => !KEYS.includes(key)))
      return null;
    const r: unknown = JSON.parse(payload);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const x = r as Record<string, unknown>;
    const int = (value: unknown, max: number) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
    if (
      x.v !== 1 ||
      x.pid !== pid ||
      !int(x.pid, 0xffffffff) ||
      pid === 0 ||
      typeof x.generation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.generation)
    )
      return null;
    if (!((x.phase === 'bootstrap' && x.ordinal === 0) || (x.phase === 'business' && x.ordinal === 1))) return null;
    if (x.status === 'identified') {
      if (
        typeof x.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(x.fingerprint) ||
        x.reason !== null ||
        x.sqliteCode !== null ||
        x.win32Code !== null
      )
        return null;
    } else if (x.status === 'unavailable') {
      if (x.fingerprint !== null || typeof x.reason !== 'string' || !REASONS.includes(x.reason)) return null;
      if (x.sqliteCode !== null && (x.reason !== 'sqlite_handle_unavailable' || !int(x.sqliteCode, 0x7fffffff)))
        return null;
      if (x.win32Code !== null && (x.reason !== 'file_identity_unavailable' || !int(x.win32Code, 0xffffffff)))
        return null;
    } else return null;
    return x as IdentityRecord;
  } catch {
    return null;
  }
}

/** One child attempt; no raw identity bytes escape the bounded framer. */
export class DatabaseIdentityCapture {
  private bytes: number[] = [];
  private overflow = false;
  private quarantined = false;
  private invalid = false;
  private generation: string | null = null;
  private records: IdentityRecord[] = [];
  private lifecycle: 'running' | 'exited_draining' | 'closed' | 'drain_timeout' = 'running';
  private ready = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly pid: number,
    readonly attemptOrdinal: number
  ) {}

  consume(chunk: Buffer, onLine: (line: string, forward: boolean) => void): void {
    if (this.lifecycle === 'closed' || this.lifecycle === 'drain_timeout') return;
    for (const byte of chunk) {
      if (byte === 0x1e) {
        this.quarantined = true;
        if (this.overflow) this.invalid = true;
      }
      if (byte === 10) {
        if (this.overflow) {
          if (this.quarantined) this.invalid = true;
        } else this.line(Buffer.from(this.bytes), onLine);
        this.bytes = [];
        this.overflow = false;
      } else if (!this.overflow) {
        if (this.bytes.length >= 8192) {
          this.bytes = [];
          this.overflow = true;
          if (this.quarantined) this.invalid = true;
        } else this.bytes.push(byte);
      }
    }
  }

  private line(bytes: Buffer, onLine: (line: string, forward: boolean) => void): void {
    const wireLength = bytes.length + 1;
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
    if (bytes.includes(0x1e)) {
      const record = wireLength <= 1024 ? parseRecord(bytes, this.pid) : null;
      if (
        !record ||
        this.records.length >= 2 ||
        (this.generation && this.generation !== record.generation) ||
        this.records.some((r) => r.ordinal >= record.ordinal)
      ) {
        this.invalid = true;
        return;
      }
      this.generation = record.generation;
      this.records.push(record);
      return;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      if (this.quarantined) this.invalid = true;
      else onLine(bytes.toString('utf8'), true);
      return;
    }
    const trimmed = text.trim();
    let listeningPort: number | undefined;
    if (trimmed.startsWith('AIONCORE_LISTENING ')) {
      try {
        const payload = trimmed.slice('AIONCORE_LISTENING '.length);
        const parsed: unknown = JSON.parse(payload);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid marker');
        const event = parsed as { port?: unknown; host?: unknown };
        const keys = Array.from(payload.matchAll(/"(?:\\.|[^"\\])*"(?=\s*:)/g), (m) => JSON.parse(m[0]) as string);
        if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('port') || !keys.includes('host'))
          throw new Error('invalid marker');
        if (event.host !== '127.0.0.1') throw new Error('invalid marker');
        if (typeof event.port === 'number' && Number.isInteger(event.port) && event.port > 0 && event.port <= 65535)
          listeningPort = event.port;
      } catch {
        /* An invalid marker is not a legacy event. */
      }
    }
    const legacy = trimmed === 'AIONCORE_READY' || listeningPort !== undefined;
    if (this.quarantined && text.trim() && !legacy) this.invalid = true;
    if (!this.quarantined) onLine(text, true);
    else if (listeningPort !== undefined) onLine(`AIONCORE_LISTENING {"port":${listeningPort}}`, false);
    else if (legacy) onLine('AIONCORE_READY', false);
  }
  markReady(): void {
    if (this.lifecycle !== 'closed' && this.lifecycle !== 'drain_timeout') this.ready = true;
  }
  exit(): void {
    if (this.lifecycle !== 'running') return;
    this.lifecycle = 'exited_draining';
    this.drainTimer = setTimeout(() => this.finish('drain_timeout'), 1000);
  }
  close(): void {
    this.finish('closed');
  }
  private finish(state: 'closed' | 'drain_timeout'): void {
    if (this.lifecycle === 'closed' || this.lifecycle === 'drain_timeout') return;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.quarantined && (this.bytes.length || this.overflow)) this.invalid = true;
    this.bytes = [];
    this.overflow = false;
    this.lifecycle = state;
  }
  snapshot() {
    return {
      attemptOrdinal: this.attemptOrdinal,
      corePid: this.pid || null,
      generation: this.generation,
      captureState: this.invalid
        ? 'invalid'
        : this.records.length === 2
          ? 'complete'
          : this.records.length
            ? 'partial'
            : 'not_observed',
      lifecycleState: this.lifecycle,
      readyObserved: this.ready,
      records: this.records.map((record) => ({ ...record })),
    };
  }
}
