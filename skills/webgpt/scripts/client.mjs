import { readFileSync, writeFileSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Shared by the worker and the controller client; never store configuration in the skill.
export function configuration(env = process.env) {
  const file = env.WEBGPT_CONFIG ?? join(homedir(), '.config', 'webgpt', 'config.json');
  if (env.WEBGPT_CONFIG && !existsSync(file)) throw Error('WEBGPT_CONFIG file does not exist');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid WebGPT configuration');
  const config = {
    dataDir: env.WEBGPT_DATA_DIR ?? saved.dataDir ?? join(homedir(), '.local', 'share', 'webgpt'),
    mcpPort: saved.mcpPort ?? 43137,
    controlPort: saved.controlPort ?? 43139,
    ...(saved.publicOrigin ? {publicOrigin: saved.publicOrigin} : {}),
  };
  if (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw Error('dataDir must be absolute');
  for (const key of ['mcpPort', 'controlPort']) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535) throw Error('invalid ' + key);
  }
  if (config.mcpPort === config.controlPort) throw Error('MCP and controller ports must differ');
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('publicOrigin must be an HTTPS origin');
    if (direct(url.hostname)) throw Error('publicOrigin must be a tunnel hostname, not a direct address: ' + url.hostname);
    config.publicOrigin = url.origin;
  }
  return config;
}

// ChatGPT reaches the worker through the tunnel and nowhere else. A bare address, or a name
// that only means something on this machine, is something pointed straight at the worker.
function direct(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':')
    || /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(bare);
}

export async function request(action, payload, config = configuration()) {
  if (!['open', 'close', 'status'].includes(action)) throw Error('unknown controller action');
  const read = action === 'status';
  if (!read && (!payload || typeof payload !== 'object')) throw Error('invalid controller payload');
  const key = readFileSync(join(config.dataDir, 'controller.key'), 'utf8');
  const response = await fetch('http://127.0.0.1:' + config.controlPort + '/' + action, {
    method: read ? 'GET' : 'POST',
    headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
    body: read ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'controller request failed: ' + response.status);
  return result;
}

// The same project keeps the same connection: reopening returns the live one instead of
// stranding the old chat, and only terminal use renews its idle lease.
export async function openProject(cwd = process.cwd(), config = configuration()) {
  const result = await request('open', {cwd: realpathSync(cwd)}, config);
  const suffix = createHash('sha256').update((config.publicOrigin ?? '') + result.id).digest('hex').slice(0, 8);
  const connectionName = 'WebGPT ' + basename(result.project) + ' ' + suffix;
  const open = {id: result.id, project: result.project, reused: result.reused,
    idleExpiresAt: result.idleExpiresAt, connectionName};
  if (!config.publicOrigin) return {...open, needsPublicOrigin: true};
  const origin = await originServing(config);
  // The URL is this machine's shell in a link. It goes to one private file and is never
  // returned, printed or passed along; whoever registers the connection reads it there.
  const connectionFile = join(config.dataDir, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify({...open, connectionUrl: config.publicOrigin + result.path,
    origin}, null, 2) + '\n', {mode: 0o600});
  return {...open, origin, connectionFile};
}

async function health(base) {
  const response = await fetch(base + '/health', {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('health check answered ' + response.status);
  return response.json();
}

// A tunnel that was restarted, rerouted, or pointed at the other worker on this machine
// is caught here rather than by a connection that answers 404 to a conversation.
async function originServing(config) {
  let mine;
  try { mine = await health('http://127.0.0.1:' + config.mcpPort); }
  catch (error) { throw Error('this worker does not answer on its own MCP port: ' + error.message); }
  let theirs;
  try { theirs = await health(config.publicOrigin); }
  catch { return 'unreachable'; }
  if (theirs.name !== mine.name || theirs.instance !== mine.instance)
    throw Error('publicOrigin serves a different worker (' + (theirs.name ?? 'unknown') + '); fix the tunnel route before connecting');
  return 'verified';
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let result;
    if (action === 'open') {
      if (args.length > 1) throw Error('usage: client.mjs open [project-directory]');
      result = await openProject(args[0]);
    } else if (action === 'status') {
      result = await request('status');
    } else if (action === 'close') {
      if (args.length !== 1) throw Error('usage: client.mjs close <project-directory|session-id>');
      result = await request('close', isAbsolute(args[0]) ? {cwd: realpathSync(args[0])} : {id: args[0]});
      const artifact = join(configuration().dataDir, 'connection.json');
      if (existsSync(artifact) && JSON.parse(readFileSync(artifact, 'utf8')).id === result.id) unlinkSync(artifact);
    } else throw Error('usage: client.mjs open|status|close');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('WebGPT: ' + error.message);
    process.exitCode = 1;
  }
}
