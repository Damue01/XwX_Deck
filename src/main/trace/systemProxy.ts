import * as net from 'net';

export type SystemProxySelection =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly url: string }
  | { readonly kind: 'unsupported'; readonly rule: string };

/** Convert the first supported Electron/Chromium PAC directive into a Node agent URL. */
export function selectSystemProxy(rules: string): SystemProxySelection {
  const directives = rules.split(';').map(value => value.trim()).filter(Boolean);
  if (directives.length === 0) return { kind: 'direct' };
  for (const directive of directives) {
    if (/^DIRECT$/i.test(directive)) return { kind: 'direct' };
    const match = /^(PROXY|HTTP|HTTPS)\s+(.+)$/i.exec(directive);
    if (!match) continue;
    const protocol = match[1].toUpperCase() === 'HTTPS' ? 'https:' : 'http:';
    const candidate = match[2].includes('://') ? match[2] : `${protocol}//${match[2]}`;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
        return { kind: 'proxy', url: parsed.toString() };
      }
    } catch {
      return { kind: 'unsupported', rule: directive };
    }
  }
  return { kind: 'unsupported', rule: directives[0] };
}

/**
 * A configured loopback proxy is usually a local proxy application. Detect a
 * stopped listener before publishing Gateway routes instead of surfacing a
 * generic upstream 502 after ChatGPT has already been switched to localhost.
 */
export async function assertLoopbackSystemProxyReachable(proxyUrl: string, timeoutMs = 500): Promise<void> {
  const parsed = new URL(proxyUrl);
  if (!isLoopbackHost(parsed.hostname)) return;
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  const reachable = await probeTcpHost(parsed.hostname, port, timeoutMs);
  if (reachable) return;
  throw new Error(`系统代理 ${parsed.host} 当前不可用，请启动代理或关闭系统代理后重试。`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4
    && parts.every(part => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
    && Number(parts[0]) === 127;
}

function probeTcpHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const done = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
