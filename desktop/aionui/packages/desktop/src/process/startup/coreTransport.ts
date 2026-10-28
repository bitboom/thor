/** Desktop-only authentication for the owned Core process. */
export function isCoreTarget(raw: string, port: number | undefined): boolean {
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === 'http:' || url.protocol === 'ws:') &&
      url.hostname === '127.0.0.1' &&
      url.port === String(port) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function sameDocument(raw: string, expected: string): boolean {
  try {
    const a = new URL(raw);
    const b = new URL(expected);
    return !a.username && !a.password && a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export function isTrustedDevDocument(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function trustedCoreRequest(input: {
  url: string;
  port?: number;
  webContentsId?: number;
  expectedWebContentsId: number;
  frameIsMain: boolean;
  frameUrl?: string;
  trustedDocuments: string[];
}): boolean {
  return (
    isCoreTarget(input.url, input.port) &&
    input.webContentsId === input.expectedWebContentsId &&
    input.frameIsMain &&
    !!input.frameUrl &&
    input.trustedDocuments.some((url) => sameDocument(input.frameUrl!, url))
  );
}

export function coreRequestHeaders(
  input: Record<string, string>,
  auth: Record<string, string>,
  trusted: boolean,
  requestUrl?: string
): Record<string, string> {
  const headers = { ...input };
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-thor-local-token') delete headers[name];
  if (trusted) {
    // Chromium serializes a file-backed renderer's WebSocket Origin as file://;
    // Core accepts the opaque origin 'null'. Restrict this to the already
    // authorized top-level Core WebSocket request and one exact Origin header.
    let isWebSocket = false;
    try {
      isWebSocket = !!requestUrl && new URL(requestUrl).protocol === 'ws:';
    } catch {
      // Invalid targets are never normalized.
    }
    const origins = Object.keys(headers).filter((name) => name.toLowerCase() === 'origin');
    if (isWebSocket && origins.length === 1 && headers[origins[0]] === 'file://') headers[origins[0]] = 'null';
    Object.assign(headers, auth);
  }
  return headers;
}

/** Called only in Electron main; injects auth for node fetch callers to Core. */
export function installCoreMainFetch(
  getPort: () => number | undefined,
  getHeaders: () => Record<string, string>,
  host: { fetch: typeof fetch } = globalThis
): void {
  const original = host.fetch.bind(host);
  host.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (!isCoreTarget(raw, getPort()) || !raw.startsWith('http://')) return original(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    for (const [key, value] of Object.entries(getHeaders())) headers.set(key, value);
    return original(input, { ...init, headers, redirect: 'error' });
  }) as typeof fetch;
}
