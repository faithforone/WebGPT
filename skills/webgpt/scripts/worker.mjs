import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Terminals } from './terminal.mjs';
import { projectRoot } from './files.mjs';
import { capabilities } from './capabilities.mjs';
import { configuration } from './client.mjs';

export const IDLE_MS = 86400000;
export const tools = capabilities.flatMap(capability => capability.tools);
const owner = name => capabilities.find(capability => capability.tools.some(tool => tool.name === name));

const guidance = cwd => 'This connection is one project on the user\'s machine: ' + cwd + '. '
  + 'Read and patch its files with read and apply_patch; run everything else — git, builds, tests, '
  + 'servers, package managers — with exec_command, and continue a running command with write_stdin. '
  + 'Commands run as the local user, not in a sandbox: stay in the project unless asked, and preserve '
  + 'unrelated work. Replies are bounded, not the commands: when more is above zero, read on with the '
  + 'returned cursor. Investigate before changing, run the project\'s own tests after changing, and '
  + 'report only checks you actually ran.';

export async function start({dir, port = 43137, controlPort = 43139, idleMs = IDLE_MS, idleSweepMs = 60000, now = Date.now} = {}) {
  dir = resolve(dir); mkdirSync(dir, {recursive: true, mode: 0o700});
  const lock = resolve(dir, 'worker.lock');
  try { mkdirSync(lock, {mode: 0o700}); }
  catch (e) { if (e.code === 'EEXIST') throw Error('WebGPT data directory locked: ' + lock + '; verify its owner before recovering a stale lock'); throw e; }
  const release = () => { if (existsSync(resolve(lock, 'owner.json'))) unlinkSync(resolve(lock, 'owner.json')); rmdirSync(lock); };
  try {
  writeFileSync(resolve(lock, 'owner.json'), JSON.stringify({pid: process.pid, host: hostname()}), {mode: 0o600});
  const statePath = resolve(dir, 'sessions.json'), keyPath = resolve(dir, 'controller.key');
  const key = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : randomUUID();
  // Identifies this running worker to whoever configured the tunnel route, so an origin
  // pointed at a different worker is caught before a connection is handed to anyone.
  const instance = randomBytes(8).toString('hex');
  if (!existsSync(keyPath)) writeFileSync(keyPath, key, {mode: 0o600, flag: 'wx'});
  // The connection URL is the capability that authenticates the remote MCP connection.
  // Keep it out of stdout, chat messages and HTTP error responses.
  const sessions = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [];
  const terminals = new Terminals();
  const persist = () => { writeFileSync(statePath + '.tmp', JSON.stringify(sessions), {mode: 0o600}); renameSync(statePath + '.tmp', statePath); };
  const active = new Map();
  // A route that cannot exist, so an almost-right URL is compared and rejected in
  // constant time instead of falling through to a shorter literal.
  const decoy = '/open/' + randomBytes(32).toString('hex');
  const expireIdle = async () => {
    const expired = sessions.filter(s => now() - s.lastUsed >= idleMs && !active.has(s.id) && !terminals.isRunning(s.id));
    if (!expired.length) return;
    for (const s of expired) sessions.splice(sessions.indexOf(s), 1);
    persist();
    await Promise.all(expired.map(s => terminals.stop(s.id)));
  };
  await expireIdle();
  const view = () => sessions.map(s => ({id: s.id, project: s.cwd, opened: s.opened,
    idleExpiresAt: s.lastUsed + idleMs, running: terminals.isRunning(s.id)}));
  const json = (res, status, value) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
  const body = async req => { const chunks = []; let bytes = 0; for await (const c of req) { bytes += c.length; if (bytes > 4 * 1024 * 1024) throw Error('request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const call = async (session, name, args) => {
    const capability = owner(name);
    if (!capability) throw Error('unknown tool');
    active.set(session.id, (active.get(session.id) ?? 0) + 1);
    try {
      const out = await capability.call(name, args, {session, terminals});
      session.lastUsed = now(); persist();
      return {out, text: capability.text?.(name, out) ?? JSON.stringify(out)};
    } finally { const left = active.get(session.id) - 1; if (left) active.set(session.id, left); else active.delete(session.id); }
  };
  const mcp = createServer(async (req, res) => {
    if (req.headers.origin) return json(res, 403, {});
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, {ok: true, name: 'WebGPT', instance});
    await expireIdle();
    const opened = (req.url ?? '').match(/^\/open\/([a-f0-9]{64})$/)?.[1];
    const session = opened && sessions.find(s => s.key === opened);
    const actual = Buffer.from(req.url ?? ''), expected = Buffer.from(session ? '/open/' + session.key : decoy);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(res, 404, {});
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return json(res, 405, {}); }
    let message; try { message = await body(req); } catch { return json(res, 400, {error: 'invalid request'}); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return json(res, 400, {error: 'invalid request'});
    if (message.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    let result;
    if (message.method === 'initialize') result = {protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      capabilities: {tools: {}}, serverInfo: {name: 'webgpt', version: '3.0.0'}, instructions: guidance(session.cwd)};
    else if (message.method === 'tools/list') result = {tools};
    else if (message.method === 'tools/call') {
      try {
        if (!tools.some(tool => tool.name === message.params?.name)) throw Error('unknown tool');
        const {out, text} = await call(session, message.params.name, message.params.arguments ?? {});
        result = {content: [{type: 'text', text}], structuredContent: out, isError: false};
      } catch (e) { result = {content: [{type: 'text', text: e.message}], isError: true}; }
    }
    else return json(res, 200, {jsonrpc: '2.0', id: message.id ?? null, error: {code: -32601, message: 'method not found'}});
    json(res, 200, {jsonrpc: '2.0', id: message.id ?? null, result});
  });
  const control = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + key) return json(res, 401, {});
    try {
      await expireIdle();
      if (req.method === 'GET' && req.url === '/status') return json(res, 200, {sessions: view()});
      if (req.method !== 'POST') return json(res, 404, {});
      const input = await body(req);
      if (req.url === '/open') {
        const grant = projectRoot(input.cwd ?? input.project);
        const live = sessions.find(s => s.cwd === grant.cwd);
        // Reopening a project shares its live connection; only terminal use renews the lease.
        if (live) return json(res, 200, {id: live.id, path: '/open/' + live.key, project: live.cwd,
          idleExpiresAt: live.lastUsed + idleMs, reused: true});
        const session = {id: randomUUID(), cwd: grant.cwd, key: randomBytes(32).toString('hex'), opened: now(), lastUsed: now()};
        sessions.push(session); persist();
        return json(res, 200, {id: session.id, path: '/open/' + session.key, project: session.cwd,
          idleExpiresAt: session.lastUsed + idleMs, reused: false});
      }
      if (req.url === '/close') {
        const session = sessions.find(s => s.id === input.id || s.cwd === input.cwd);
        if (!session) throw Error('unknown session');
        sessions.splice(sessions.indexOf(session), 1); persist();
        await terminals.stop(session.id);
        return json(res, 200, {ok: true, id: session.id});
      }
      return json(res, 404, {});
    } catch (e) { json(res, 400, {error: e.message}); }
  });
  for (const server of [mcp, control]) server.requestTimeout = 15000;
  const listen = (s, p) => new Promise((yes, no) => { s.once('error', no); s.listen(p, '127.0.0.1', yes); });
  try { await listen(mcp, port); await listen(control, controlPort); } catch (e) { mcp.close(); control.close(); throw e; }
  let closed = false;
  const idleTimer = setInterval(() => expireIdle().catch(error => console.error('WebGPT idle cleanup:', error.message)), idleSweepMs); idleTimer.unref();
  return {mcpPort: mcp.address().port, controlPort: control.address().port, key, instance, expireIdle,
    close: async () => { if (closed) return; closed = true; clearInterval(idleTimer);
      await Promise.all([mcp, control].map(s => new Promise(r => { s.closeAllConnections(); s.close(r); })));
      await terminals.stop(); release(); }};
  } catch (e) { release(); throw e; }
}
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const config = configuration();
  const service = await start({dir: config.dataDir, port: config.mcpPort, controlPort: config.controlPort});
  console.log(JSON.stringify({ready: true, mcpPort: service.mcpPort, controlPort: service.controlPort}));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().then(() => process.exit(0)));
}
