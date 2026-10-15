import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectPublicHistory } from '../checks/public-history.mjs';

const root = await mkdtemp(join(tmpdir(), 'xwx-history-audit-'));
const names = [['paper', 'hub'], ['x', '3', 'client']].map(parts => parts.join(''));
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const git = (directory, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const commit = directory => { git(directory, 'add', '-A'); git(directory, 'commit', '-m', 'Fixture change'); };
try {
  for (const [index, scenario] of ['clean', 'deleted-content', 'renamed-file', 'commit-message', 'tag-message', 'other-branch', 'ref-name'].entries()) {
    const directory = join(root, String(index));
    git(root, 'init', '--initial-branch=main', directory);
    await writeFile(join(directory, 'fixture.txt'), 'Public fixture\n');
    commit(directory);
    if (scenario === 'deleted-content') {
      await writeFile(join(directory, 'deleted.txt'), names[0].toUpperCase());
      commit(directory);
      await rm(join(directory, 'deleted.txt'));
      commit(directory);
    } else if (scenario === 'renamed-file') {
      await rename(join(directory, 'fixture.txt'), join(directory, names[1] + '.txt'));
      commit(directory);
      await rename(join(directory, names[1] + '.txt'), join(directory, 'fixture.txt'));
      commit(directory);
    } else if (scenario === 'commit-message') {
      git(directory, 'commit', '--allow-empty', '-m', names[1]);
    } else if (scenario === 'tag-message') {
      git(directory, 'tag', '-a', 'fixture-tag', '-m', names[0]);
    } else if (scenario === 'other-branch') {
      git(directory, 'checkout', '-b', 'fixture-branch');
      await writeFile(join(directory, 'fixture.txt'), names[1]);
      commit(directory);
      git(directory, 'checkout', 'main');
    } else if (scenario === 'ref-name') {
      git(directory, 'branch', names[0]);
    }
    const result = inspectPublicHistory(directory, names);
    assert.equal(result.failures.length === 0, scenario === 'clean', scenario);
    assert.ok(result.counts.commit > 0 && result.counts.tree > 0 && result.counts.blob > 0);
  }
  const shallow = join(root, 'shallow');
  git(root, 'clone', '--depth=1', pathToFileURL(join(root, '1')).href, shallow);
  assert.throws(() => inspectPublicHistory(shallow, names), /complete checkout/);
  console.log('PASS repository history audit: clean history, deleted contents, renamed files, commit/tag messages, other branches, ref names and shallow checkout');
} finally {
  await rm(root, { recursive: true, force: true });
}
