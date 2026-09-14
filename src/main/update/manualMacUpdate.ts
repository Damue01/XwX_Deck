const MAC_DMG_NAMES: Record<string, string> = {
  arm64: 'XwX-Deck-mac-arm64.dmg',
  x64: 'XwX-Deck-mac-x64.dmg'
};

export interface PublishedArtifact {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ManualMacReleaseSelection {
  readonly version: string;
  readonly publishedAt?: string;
  readonly changelog?: string;
  readonly artifact: PublishedArtifact;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const before = parseVersion(current);
  if (!next || !before) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== before[index]) return next[index] > before[index];
  }
  return false;
}

export function resolveManualMacRelease(
  value: unknown,
  currentVersion: string,
  architecture: string
): ManualMacReleaseSelection | undefined {
  if (!isRecord(value) || !isValidVersion(value.version)) {
    throw new Error('更新清单中的版本号无效。');
  }
  if (!isVersionNewer(value.version, currentVersion)) return undefined;
  const artifactName = MAC_DMG_NAMES[architecture];
  if (!artifactName) throw new Error(`当前 Mac 架构暂不支持更新：${architecture}。`);
  if (!Array.isArray(value.files)) throw new Error('更新清单中的安装包列表无效。');
  const files = value.files;
  const rawArtifact = files.find(item => isRecord(item) && item.name === artifactName);
  // The shared release feed may legitimately contain only the Windows EXE
  // until a same-commit macOS candidate is uploaded. That is not a malformed
  // Mac update; it simply means this release has no artifact for this Mac.
  if (!isRecord(rawArtifact)) return undefined;
  if (
    rawArtifact.name !== artifactName
    || typeof rawArtifact.url !== 'string'
    || !isAllowedArtifactUrl(rawArtifact.url)
    || !Number.isSafeInteger(rawArtifact.size)
    || Number(rawArtifact.size) < 1
    || typeof rawArtifact.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(rawArtifact.sha256)
  ) {
    throw new Error(`XwX Deck ${value.version} 的更新清单中缺少有效的 ${artifactName}。`);
  }
  return {
    version: value.version,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
    changelog: typeof value.changelog === 'string' ? value.changelog : undefined,
    artifact: {
      name: artifactName,
      url: rawArtifact.url,
      size: Number(rawArtifact.size),
      sha256: rawArtifact.sha256.toLowerCase()
    }
  };
}

function isValidVersion(value: unknown): value is string {
  return typeof value === 'string' && parseVersion(value) !== undefined;
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}
