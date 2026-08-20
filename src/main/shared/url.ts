export function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Extract the explicit port from an http(s) URL, or `undefined` when absent/unparseable. */
export function parsePort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/[^/:]+:(\d+)/i.exec(url);
  return m ? Number(m[1]) : undefined;
}
