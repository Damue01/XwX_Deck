import assert from 'node:assert/strict';
import { ownedFolderWindows } from './windows-folder-windows.mjs';
const root = 'E:\\fixtures\\试验pilot';
const baseline = [{ id: '1', path: root + '\\logs' }, { id: '2', path: 'C:\\Users\\Public' }];
const windows = [...baseline, { id: '3', path: root + '\\logs' }, { id: '4', path: root },
  { id: '5', path: root + '-other\\logs' }, { id: '6', path: 'C:\\Downloads' },
  { id: '7', path: root + '\\traces' }, { id: '7', path: 'C:\\Downloads' },
  { id: '8', path: 'e:/FIXTURES/试验pilot/traces' }, { id: '9', path: 'shell:Downloads' }];
assert.deepEqual(ownedFolderWindows(windows, baseline, root).map(w => w.id), ['3', '4', '8']);
assert.deepEqual(ownedFolderWindows([], baseline, root), []);
assert.deepEqual(ownedFolderWindows([{ id: '3', path: 'C:\\Downloads' }], baseline, root), []);
console.log('PASS folder-window ownership: pre-existing windows, unrelated paths, sibling prefixes, mixed tabs and user navigation are preserved; owned Unicode/case-normalized paths are selected');
