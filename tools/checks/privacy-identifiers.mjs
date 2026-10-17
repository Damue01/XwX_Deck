import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Only irreversible fingerprints are committed. Rules must not disclose names.
export function createIdentifierMatcher(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.length) || entry.length < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid privacy fingerprint');
    const key = `${entry.length}:${Boolean(entry.short)}`;
    if (!groups.has(key)) groups.set(key, { length: entry.length, short: Boolean(entry.short), digests: new Set() });
    groups.get(key).digests.add(entry.sha256);
  }
  const digest = text => createHash('sha256').update(text).digest('hex');
  return (content, { includeShort = true } = {}) => {
    // Tokens cover identifiers, host names, paths and camel-case substrings.
    const tokens = new Set(content.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const group of groups.values()) {
      if (group.short && !includeShort) continue;
      for (const token of tokens) {
        if (group.short) {
          if (token.length === group.length && group.digests.has(digest(token))) return true;
        } else {
          for (let start = 0; start <= token.length - group.length; start++) {
            if (group.digests.has(digest(token.slice(start, start + group.length)))) return true;
          }
        }
      }
    }
    return false;
  };
}
const policy = JSON.parse(readFileSync(new URL('./repository-policy.json', import.meta.url), 'utf8'));
export const containsPrivateIdentifier = createIdentifierMatcher(policy.forbiddenIdentifierDigests);
