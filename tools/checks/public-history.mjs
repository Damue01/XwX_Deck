import { spawnSync } from 'node:child_process';

// This is a repository audit. It never inspects application user data.
export function inspectPublicHistory(root, forbiddenNames, forbiddenPatterns = [], authorEmailDomains = []) {
  const git = (args, input, encoding = 'utf8') => {
    const result = spawnSync('git', args, { cwd: root, input, encoding, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(`Git history audit failed: ${args[0]}`);
    return result.stdout;
  };
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw Error('Git history audit requires a complete checkout');
  }
  const failures = [];
  const patterns = forbiddenPatterns.map(pattern => new RegExp(pattern, 'iu'));
  const rejects = content => (typeof forbiddenNames === 'function' ? forbiddenNames(content, { includeShort: false })
    : forbiddenNames.some(name => content.toLowerCase().includes(name.toLowerCase()))) || patterns.some(pattern => pattern.test(content));
  for (const ref of git(['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean)) {
    if (rejects(ref)) failures.push('Git reference contains an internal name');
  }
  const ids = git(['rev-list', '--objects', '--all', '--no-object-names']).trim().split('\n').filter(Boolean);
  const metadata = git(['cat-file', '--batch-check'], ids.join('\n') + '\n').trim().split('\n');
  const counts = { commit: 0, tree: 0, blob: 0, tag: 0 };
  let batch = [];
  let bytes = 0;
  const inspect = () => {
    if (!batch.length) return;
    const output = git(['cat-file', '--batch'], batch.join('\n') + '\n', null);
    let offset = 0;
    for (const id of batch) {
      const end = output.indexOf(10, offset);
      const [actualId, type, length] = output.subarray(offset, end).toString('utf8').split(' ');
      const size = Number(length);
      if (end < offset || actualId !== id || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= output.length) {
        throw Error('Git history audit received an incomplete object');
      }
      // Tree objects carry every historical filename, including renamed files.
      // Commit/tag objects carry messages and author metadata; blobs carry contents.
      const body = output.subarray(end + 1, end + 1 + size);
      if (authorEmailDomains.length && (type === 'commit' || type === 'tag')) {
        const headers = body.toString('utf8').split('\n\n', 1)[0];
        for (const match of headers.matchAll(/^(?:author|committer|tagger) .*<([^>]+)>/gm)) {
          const domain = match[1].split('@').at(-1).toLowerCase();
          if (!authorEmailDomains.includes(domain)) failures.push(`Git ${type} ${id}: private author email`);
        }
      }
      // Native resources and Windows files can carry UTF-16 private strings.
      if ([body.toString('utf8'), body.toString('utf16le'), body.subarray(1).toString('utf16le')].some(rejects)) {
        failures.push(`Git ${type} ${id}: private text in history`);
      }
      counts[type]++;
      offset = end + size + 2;
    }
    batch = [];
    bytes = 0;
  };
  for (const line of metadata) {
    const [id, type, length] = line.split(' ');
    const size = Number(length);
    if (!Object.hasOwn(counts, type) || !Number.isSafeInteger(size)) throw Error('Git history audit could not read an object');
    if (batch.length && bytes + size > 8 * 1024 * 1024) inspect();
    batch.push(id);
    bytes += size;
  }
  inspect();
  return { failures, counts };
}
