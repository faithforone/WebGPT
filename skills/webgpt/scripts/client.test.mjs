import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { configuration, openProject, request } from './client.mjs';
import { start } from './worker.mjs';

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'webgpt-client-')));
const saved = value => {
  const file = join(dir(), 'config.json');
  writeFileSync(file, JSON.stringify(value));
  return {WEBGPT_CONFIG: file};
};

test('configuration falls back to documented defaults', () => {
  const config = configuration({WEBGPT_CONFIG: undefined, HOME: '/home/someone', WEBGPT_DATA_DIR: '/data/webgpt'});
  assert.equal(config.dataDir, '/data/webgpt');
  assert.deepEqual([config.mcpPort, config.controlPort], [43137, 43139]);
  assert.equal(config.publicOrigin, undefined);
});

test('a broken configuration is refused, not guessed at', () => {
  assert.throws(() => configuration({WEBGPT_CONFIG: join(dir(), 'nothing.json')}), /does not exist/);
  assert.throws(() => configuration(saved({dataDir: 'relative'})), /dataDir must be absolute/);
  assert.throws(() => configuration(saved({mcpPort: 0})), /invalid mcpPort/);
  assert.throws(() => configuration(saved({mcpPort: 43139})), /ports must differ/);
  assert.throws(() => configuration(saved({publicOrigin: 'http://example.com'})), /HTTPS origin/);
  assert.throws(() => configuration(saved({publicOrigin: 'https://example.com/path'})), /HTTPS origin/);
  assert.equal(configuration(saved({publicOrigin: 'https://example.com'})).publicOrigin, 'https://example.com');
});

test('an origin that is not a tunnel is refused', () => {
  for (const origin of ['https://203.0.113.10', 'https://localhost', 'https://worker.local',
                        'https://[2001:db8::1]', 'https://box.internal']) {
    assert.throws(() => configuration(saved({publicOrigin: origin})), /not a direct address|HTTPS origin/, origin);
  }
  assert.equal(configuration(saved({publicOrigin: 'https://webgpt-core.example.com'})).publicOrigin,
    'https://webgpt-core.example.com');
});

test('opening a project keeps the URL in one private file and out of the result', async t => {
  const data = dir(), project = dir();
  const service = await start({dir: data, port: 0, controlPort: 0});
  t.after(() => service.close());
  const config = {dataDir: data, mcpPort: service.mcpPort, controlPort: service.controlPort,
    publicOrigin: 'http://127.0.0.1:' + service.mcpPort};
  const opened = await openProject(project, config);
  assert.match(opened.connectionName, /^WebGPT .+ [a-f0-9]{8}$/);
  assert.deepEqual([opened.reused, opened.origin], [false, 'verified']);
  assert.equal(JSON.stringify(opened).includes('/open/'), false);
  assert.equal(opened.connectionUrl, undefined);

  const artifact = JSON.parse(readFileSync(opened.connectionFile, 'utf8'));
  assert.match(artifact.connectionUrl, new RegExp('^' + config.publicOrigin + '/open/[a-f0-9]{64}$'));
  assert.equal(statSync(opened.connectionFile).mode & 0o777, 0o600);

  const again = await openProject(project, config);
  assert.deepEqual([again.connectionName, again.reused], [opened.connectionName, true]);
  const other = await openProject(dir(), config);
  assert.notEqual(other.connectionName, opened.connectionName);

  const local = await openProject(project, {...config, publicOrigin: undefined});
  assert.equal(local.needsPublicOrigin, true);
  assert.equal(local.connectionFile, undefined);
  await assert.rejects(request('register', {}, config), /unknown controller action/);
});

test('an origin serving another worker is refused, and an unreachable one is reported', async t => {
  const data = dir(), project = dir();
  const mine = await start({dir: data, port: 0, controlPort: 0});
  const stranger = await start({dir: dir(), port: 0, controlPort: 0});
  t.after(() => Promise.all([mine.close(), stranger.close()]));
  assert.notEqual(mine.instance, stranger.instance);
  const config = {dataDir: data, mcpPort: mine.mcpPort, controlPort: mine.controlPort,
    publicOrigin: 'http://127.0.0.1:' + stranger.mcpPort};
  await assert.rejects(openProject(project, config), /serves a different worker/);
  assert.equal(existsSync(join(data, 'connection.json')), false);

  const unreachable = await openProject(project, {...config, publicOrigin: 'http://127.0.0.1:1'});
  assert.equal(unreachable.origin, 'unreachable');
});
