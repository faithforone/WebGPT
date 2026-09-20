import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, tools } from './worker.mjs';

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'webgpt-worker-')));

async function worker(t, options = {}) {
  const service = await start({dir: dir(), port: 0, controlPort: 0, ...options});
  t.after(() => service.close());
  const mcp = 'http://127.0.0.1:' + service.mcpPort;
  const control = async (path, payload, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:' + service.controlPort + path, {
      method, headers: {authorization: 'Bearer ' + service.key, 'content-type': 'application/json'},
      body: method === 'POST' ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  const rpc = async (path, method, params) => (await fetch(mcp + path, {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})).json();
  const callTool = async (path, name, args) => (await rpc(path, 'tools/call', {name, arguments: args})).result;
  return {service, mcp, control, rpc, callTool};
}

test('a project gets one private route, and reopening shares it', async t => {
  const {control} = await worker(t);
  const project = dir(), other = dir();
  const first = (await control('/open', {cwd: project})).body;
  assert.match(first.path, /^\/open\/[a-f0-9]{64}$/);
  assert.equal(first.reused, false);
  assert.equal(first.project, project);
  const again = (await control('/open', {cwd: project})).body;
  assert.deepEqual([again.path, again.reused], [first.path, true]);
  const second = (await control('/open', {cwd: other})).body;
  assert.notEqual(second.path, first.path);
  assert.equal((await control('/open', {cwd: join(project, 'missing')})).status, 400);
  assert.equal((await control('/open', {cwd: 'relative'})).status, 400);
});

test('the route serves this project, and nothing else answers', async t => {
  const {mcp, control, rpc} = await worker(t);
  const project = dir();
  const {path} = (await control('/open', {cwd: project})).body;
  const started = await rpc(path, 'initialize', {});
  assert.ok(started.result.instructions.includes(project));
  const listed = await rpc(path, 'tools/list', {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['apply_patch', 'exec_command', 'read', 'write_stdin']);
  assert.equal(listed.result.tools.length, tools.length);
  assert.equal((await fetch(mcp + '/open/' + 'f'.repeat(64), {method: 'POST', body: '{}'})).status, 404);
  assert.equal((await fetch(mcp + '/open/')).status, 404);
  assert.equal((await fetch(mcp + path)).status, 405);
  assert.equal((await fetch(mcp + path, {method: 'POST', headers: {origin: 'https://chatgpt.com'}, body: '{}'})).status, 403);
  const health = await (await fetch(mcp + '/health')).json();
  assert.equal(health.name, 'WebGPT');
  assert.match(health.instance, /^[a-f0-9]{16}$/);
  assert.deepEqual(await (await fetch(mcp + '/health')).json(), health);
});

test('the four tools do the work of a local developer', async t => {
  const {control, callTool} = await worker(t);
  const project = dir();
  writeFileSync(join(project, 'app.txt'), 'one\ntwo\n');
  const {path} = (await control('/open', {cwd: project})).body;

  const read = await callTool(path, 'read', {path: 'app.txt'});
  assert.equal(read.isError, false);
  assert.ok(read.content[0].text.includes('one\ntwo'));
  assert.equal(read.structuredContent.total_lines, 2);

  const patched = await callTool(path, 'apply_patch', {patch:
    ['*** Begin Patch', '*** Update File: app.txt', '@@', ' one', '-two', '+TWO', '*** End Patch'].join('\n')});
  assert.equal(patched.isError, false);
  assert.equal(readFileSync(join(project, 'app.txt'), 'utf8'), 'one\nTWO\n');

  const ran = await callTool(path, 'exec_command', {command: 'cat app.txt'});
  assert.equal(ran.isError, false);
  assert.ok(ran.content[0].text.includes('TWO'));
  const session = ran.structuredContent.session_id;
  const more = await callTool(path, 'write_stdin', {session_id: session, cursor: 0, yield_ms: 100});
  assert.ok(more.content[0].text.includes('TWO'));

  const failed = await callTool(path, 'read', {path: 'nope.txt'});
  assert.equal(failed.isError, true);
  const unknown = await callTool(path, 'delete_everything', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown tool/);
});

test('a command keeps running between calls and can be stopped', async t => {
  const {control, callTool} = await worker(t);
  const {path} = (await control('/open', {cwd: dir()})).body;
  const started = await callTool(path, 'exec_command', {command: 'sleep 30', yield_ms: 50});
  assert.equal(started.structuredContent.running, true);
  const stopped = await callTool(path, 'write_stdin', {session_id: started.structuredContent.session_id, signal: 'SIGKILL', yield_ms: 2000});
  assert.equal(stopped.structuredContent.running, false);
});

test('use renews the lease, reopening does not, and idle routes stop answering', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const {mcp, control, callTool, rpc} = await worker(t, {idleMs: 1000, now: () => clock, idleSweepMs: 3600000});
  const project = dir();
  const opened = (await control('/open', {cwd: project})).body;
  clock += 800;
  assert.equal((await control('/open', {cwd: project})).body.idleExpiresAt, opened.idleExpiresAt);
  await callTool(opened.path, 'exec_command', {command: 'printf .', yield_ms: 100});
  clock += 800;
  // Tool discovery is not use; the command a moment ago is what kept the lease alive.
  assert.equal((await rpc(opened.path, 'tools/list', {})).result.tools.length, 4);
  clock += 2000;
  const gone = await fetch(mcp + opened.path, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})});
  assert.equal(gone.status, 404);
  assert.deepEqual((await control('/status', null, 'GET')).body.sessions, []);
});

test('the controller needs its key and never hands out a route', async t => {
  const {service, control} = await worker(t);
  const project = dir();
  await control('/open', {cwd: project});
  const listed = (await control('/status', null, 'GET')).body.sessions;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project, project);
  assert.equal(JSON.stringify(listed).includes('key'), false);
  const refused = await fetch('http://127.0.0.1:' + service.controlPort + '/status', {headers: {authorization: 'Bearer wrong'}});
  assert.equal(refused.status, 401);
  assert.equal((await control('/close', {cwd: project})).body.ok, true);
  assert.deepEqual((await control('/status', null, 'GET')).body.sessions, []);
  assert.equal((await control('/close', {cwd: project})).status, 400);
});

test('open sessions survive a restart of the worker', async t => {
  const data = dir(), project = dir();
  const first = await start({dir: data, port: 0, controlPort: 0});
  const opened = await (await fetch('http://127.0.0.1:' + first.controlPort + '/open', {method: 'POST',
    headers: {authorization: 'Bearer ' + first.key, 'content-type': 'application/json'},
    body: JSON.stringify({cwd: project})})).json();
  await first.close();
  assert.equal(existsSync(join(data, 'worker.lock')), false);
  const second = await start({dir: data, port: 0, controlPort: 0});
  t.after(() => second.close());
  const listed = await (await fetch('http://127.0.0.1:' + second.mcpPort + opened.path, {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})})).json();
  assert.equal(listed.result.tools.length, 4);
  await assert.rejects(start({dir: data, port: 0, controlPort: 0}), /locked/);
});
