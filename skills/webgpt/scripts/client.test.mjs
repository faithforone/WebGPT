import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
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

test('opening a project returns the name and URL to connect, and reopening repeats them', async t => {
  const data = dir(), project = dir();
  const service = await start({dir: data, port: 0, controlPort: 0});
  t.after(() => service.close());
  const config = {dataDir: data, mcpPort: service.mcpPort, controlPort: service.controlPort, publicOrigin: 'https://example.com'};
  const opened = await openProject(project, config);
  assert.equal(opened.reused, false);
  assert.equal(opened.connectionName, 'WebGPT ' + basename(project) + ' ' + opened.connectionName.split(' ').pop());
  assert.match(opened.connectionName, /^WebGPT .+ [a-f0-9]{8}$/);
  assert.equal(opened.connectionUrl, 'https://example.com' + opened.path);
  const again = await openProject(project, config);
  assert.deepEqual([again.connectionName, again.connectionUrl, again.reused], [opened.connectionName, opened.connectionUrl, true]);
  const other = await openProject(dir(), config);
  assert.notEqual(other.connectionName, opened.connectionName);

  const local = await openProject(project, {...config, publicOrigin: undefined});
  assert.equal(local.needsPublicOrigin, true);
  assert.equal(local.connectionUrl, undefined);
  assert.notEqual(local.connectionName, opened.connectionName);

  assert.deepEqual((await request('status', undefined, config)).sessions.map(s => s.project).sort(),
    [project, other.project].sort());
  await assert.rejects(request('register', {}, config), /unknown controller action/);
});
