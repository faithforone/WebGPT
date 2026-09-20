import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText, applyPatch, projectRoot } from './files.mjs';

const project = () => realpathSync(mkdtempSync(join(tmpdir(), 'webgpt-files-')));
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

test('a file arrives as a bounded window that says where it stopped', () => {
  const root = project();
  writeFileSync(join(root, 'many.txt'), Array.from({length: 50}, (_, i) => 'line ' + (i + 1)).join('\n') + '\n');
  const first = readText(root, {path: 'many.txt', limit: 10});
  assert.equal(first.content, Array.from({length: 10}, (_, i) => 'line ' + (i + 1)).join('\n'));
  assert.deepEqual([first.start_line, first.end_line, first.total_lines, first.eof, first.truncated], [1, 10, 50, false, true]);
  const rest = readText(root, {path: 'many.txt', offset: 41, limit: 10});
  assert.deepEqual([rest.start_line, rest.end_line, rest.eof, rest.truncated], [41, 50, true, false]);
  const clipped = readText(root, {path: 'many.txt', max_chars: 20});
  assert.ok(clipped.content.length <= 20);
  assert.equal(clipped.truncated, true);
});

test('a file that is not text is named, not dumped', () => {
  const root = project();
  writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
  assert.deepEqual(readText(root, {path: 'blob.bin'}), {path: 'blob.bin', binary: true, bytes: 5});
});

test('the file tools stay inside the connected project', () => {
  const root = project(), outside = project();
  writeFileSync(join(outside, 'secret.txt'), 'no\n');
  symlinkSync(outside, join(root, 'link'));
  assert.throws(() => readText(root, {path: '../secret.txt'}), /outside the connected project/);
  assert.throws(() => readText(root, {path: join(outside, 'secret.txt')}), /outside the connected project/);
  assert.throws(() => readText(root, {path: 'link/secret.txt'}), /outside the connected project/);
  assert.throws(() => applyPatch(root, patch('*** Add File: ../escape.txt', '+x')), /outside the connected project/);
  assert.equal(existsSync(join(outside, 'escape.txt')), false);
  assert.throws(() => projectRoot('relative/path'), /must be absolute/);
  assert.throws(() => readText(root, {path: '.'}), /outside the connected project/);
});

test('one patch adds, updates and deletes together', () => {
  const root = project();
  writeFileSync(join(root, 'keep.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  const result = applyPatch(root, patch(
    '*** Add File: src/new.txt', '+fresh', '+lines',
    '*** Update File: keep.txt', '@@', ' one', '-two', '+TWO', ' three',
    '*** Delete File: gone.txt'));
  assert.equal(result.applied, true);
  assert.equal(readFileSync(join(root, 'src/new.txt'), 'utf8'), 'fresh\nlines\n');
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'one\nTWO\nthree\n');
  assert.equal(existsSync(join(root, 'gone.txt')), false);
  assert.deepEqual(result.files.map(f => [f.action, f.path, f.added, f.removed]),
    [['added', 'src/new.txt', 2, 0], ['updated', 'keep.txt', 1, 1], ['deleted', 'gone.txt', 0, 1]]);
});

test('an update can move the file it rewrites', () => {
  const root = project();
  mkdirSync(join(root, 'old'));
  writeFileSync(join(root, 'old/name.txt'), 'alpha\nbeta\n');
  const result = applyPatch(root, patch('*** Update File: old/name.txt', '*** Move to: new/name.txt',
    '@@', ' alpha', '-beta', '+BETA'));
  assert.equal(existsSync(join(root, 'old/name.txt')), false);
  assert.equal(readFileSync(join(root, 'new/name.txt'), 'utf8'), 'alpha\nBETA\n');
  assert.equal(result.files[0].moved_to, 'new/name.txt');
});

test('nothing is written when any part of the patch does not fit', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  assert.throws(() => applyPatch(root, patch(
    '*** Add File: b.txt', '+new',
    '*** Update File: a.txt', '@@', ' one', '-missing', '+other')), /does not match the file/);
  assert.equal(existsSync(join(root, 'b.txt')), false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
});

test('context matching tolerates trailing whitespace but not different code', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'const x = 1;   \nconst y = 2;\n');
  applyPatch(root, patch('*** Update File: a.txt', '@@', ' const x = 1;', '-const y = 2;', '+const y = 3;'));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'const x = 1;   \nconst y = 3;\n');
  assert.throws(() => applyPatch(root, patch('*** Update File: a.txt', '@@', ' const z = 9;', '-const y = 3;', '+const y = 4;')),
    /does not match the file/);
});

test('a header locates the right copy of repeated context', () => {
  const root = project();
  writeFileSync(join(root, 'a.py'), ['def first():', '    value = 0', '    return value',
    '', 'def second():', '    value = 0', '    return value', ''].join('\n'));
  applyPatch(root, patch('*** Update File: a.py', '@@ def second():', '     value = 0', '-    return value', '+    return value + 1'));
  assert.equal(readFileSync(join(root, 'a.py'), 'utf8'),
    ['def first():', '    value = 0', '    return value', '', 'def second():', '    value = 0', '    return value + 1', ''].join('\n'));
});

test('additions can be anchored to the end of the file', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  applyPatch(root, patch('*** Update File: a.txt', '@@', ' two', '+three', '*** End of File'));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('the envelope is checked before anything is applied', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'one\n');
  assert.throws(() => applyPatch(root, 'just text'), /must start with \*\*\* Begin Patch/);
  assert.throws(() => applyPatch(root, '*** Begin Patch\n*** Add File: b.txt\n+x'), /must end with \*\*\* End Patch/);
  assert.throws(() => applyPatch(root, patch('*** Add File: a.txt', '+x')), /already exists/);
  assert.throws(() => applyPatch(root, patch('*** Delete File: nope.txt')), /does not exist/);
  assert.throws(() => applyPatch(root, patch('*** Update File: nope.txt', '@@', ' x')), /does not exist/);
  assert.throws(() => applyPatch(root, patch('*** Add File: b.txt', 'x')), /must start with \+/);
  assert.throws(() => applyPatch(root, patch('*** Update File: a.txt', '@@', ' one', '*** Update File: a.txt', '@@', ' one')), /twice/);
  assert.equal(existsSync(join(root, 'b.txt')), false);
});
