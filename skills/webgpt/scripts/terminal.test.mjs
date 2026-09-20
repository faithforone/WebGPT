import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { Terminals, DEFAULT_CHARS } from './terminal.mjs';

const grant = {cwd: tmpdir()};
const settle = async (terminals, owner, first) => {
  let last = first;
  while (last.running) last = await terminals.read(owner, {session_id: last.session_id, yield_ms: 2000, max_chars: 100000});
  return last;
};

test('a command runs and reports its exit status', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'printf hello; exit 3'});
  const end = await settle(terminals, 'a', started);
  assert.equal(end.running, false);
  assert.equal(end.exit_code, 3);
  assert.match(started.output + end.output, /hello/);
  await terminals.stop();
});

test('output is bounded per reply and continues at the cursor', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"', max_chars: 5000});
  let seen = started.output, last = started;
  assert.ok(started.output.length <= 5000);
  while (last.running || last.more) {
    last = await terminals.read('a', {session_id: last.session_id, yield_ms: 2000, max_chars: 5000});
    assert.ok(last.output.length <= 5000);
    seen += last.output;
  }
  assert.equal(seen.length, 20000);
  assert.equal(last.cursor, 20000);
  assert.equal(last.more, 0);
  await terminals.stop();
});

test('an earlier cursor re-reads output that was already delivered', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'printf abcdefghij'});
  const end = await settle(terminals, 'a', started);
  assert.equal(end.running, false);
  const again = await terminals.read('a', {session_id: started.session_id, cursor: 0, yield_ms: 0});
  assert.equal(again.output, 'abcdefghij');
  assert.equal(again.dropped, 0);
  await terminals.stop();
});

test('output past the kept buffer is reported as dropped, keeping the tail', async () => {
  const terminals = new Terminals({buffer: 500});
  const started = await terminals.execute('a', grant, {command: 'node -e "process.stdout.write(\'y\'.repeat(4000))"', yield_ms: 0, max_chars: 100000});
  const end = await settle(terminals, 'a', started);
  const tail = await terminals.read('a', {session_id: started.session_id, cursor: 0, yield_ms: 0, max_chars: 100000});
  assert.equal(tail.output.length, 500);
  assert.equal(tail.dropped, 3500);
  assert.equal(end.exit_code, 0);
  await terminals.stop();
});

test('input and signals reach a running command', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'read line; printf "got %s" "$line"', yield_ms: 50});
  assert.equal(started.running, true);
  const answered = await terminals.read('a', {session_id: started.session_id, input: 'now\n', yield_ms: 2000});
  const end = await settle(terminals, 'a', answered);
  assert.match(answered.output + end.output, /got now/);

  const sleeping = await terminals.execute('a', grant, {command: 'sleep 30', yield_ms: 50});
  const killed = await settle(terminals, 'a', await terminals.read('a', {session_id: sleeping.session_id, signal: 'SIGKILL', yield_ms: 2000}));
  assert.equal(killed.running, false);
  await terminals.stop();
});

test('a real terminal is available and answers as a tty', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'test -t 0 && echo interactive', tty: true, yield_ms: 2000});
  const end = await settle(terminals, 'a', started);
  assert.match(started.output + end.output, /interactive/);
  await terminals.stop();
});

test('sessions belong to their connection and take sane arguments', async () => {
  const terminals = new Terminals();
  const started = await terminals.execute('a', grant, {command: 'printf .'});
  await assert.rejects(terminals.read('b', {session_id: started.session_id}), /unknown terminal session/);
  await assert.rejects(terminals.read('a', {session_id: started.session_id, cursor: -1}), /cursor/);
  await assert.rejects(terminals.read('a', {session_id: started.session_id, max_chars: 0}), /max_chars/);
  await assert.rejects(terminals.execute('a', null, {command: 'printf .'}), /not granted/);
  assert.equal(DEFAULT_CHARS > 0, true);
  await terminals.stop();
});

test('finished sessions are pruned and running ones are not', async () => {
  const terminals = new Terminals();
  const done = await settle(terminals, 'a', await terminals.execute('a', grant, {command: 'printf .'}));
  const running = await terminals.execute('a', grant, {command: 'sleep 30', yield_ms: 50});
  assert.equal(terminals.isRunning('a'), true);
  terminals.prune(Date.now() + 3600000);
  assert.equal(terminals.sessions.has(done.session_id), false);
  assert.equal(terminals.sessions.has(running.session_id), true);
  await terminals.stop();
  assert.equal(terminals.sessions.size, 0);
});
