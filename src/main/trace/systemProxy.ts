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
