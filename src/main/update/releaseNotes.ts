export function normalizeReleaseNotes(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map(item => isRecord(item) && typeof item.note === 'string' ? item.note.trim() : '')
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

export function releaseNotesFromManifest(value: unknown, targetVersion: string): string | undefined {
  if (!isRecord(value) || value.version !== targetVersion) return undefined;
  return normalizeReleaseNotes(value.changelog);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
