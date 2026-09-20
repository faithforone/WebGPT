import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import * as pty from 'node-pty';

// The conversation's context is the scarce resource here, not the machine. A long build or
// a chatty test runner must never arrive as one unbounded blob, so output is buffered and
// handed out in bounded slices at an explicit cursor: the reader decides how much it takes
// and can re-read what it already saw. The command itself is never truncated or timed out.
export const BUFFER_CHARS = 1 << 20;
export const DEFAULT_CHARS = 8000;
export const MAX_CHARS = 100000;
export const FINISHED_TTL_MS = 900000;
export const MAX_SESSIONS = 64;
const INTERRUPT = String.fromCharCode(3);

function count(value, fallback, limit, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > limit) throw Error(name + ' must be an integer between 1 and ' + limit);
  return value;
}

// The cwd is a convenience, not a sandbox. Commands inherit the worker user's OS access.
export class Terminals {
  sessions = new Map();

  constructor({buffer = BUFFER_CHARS} = {}) { this.buffer = buffer; }

  isRunning(owner) {
    return [...this.sessions.values()].some(s => s.owner === owner && !s.done);
  }

  prune(now = Date.now()) {
    const finished = [...this.sessions].filter(([, s]) => s.done);
    for (const [id, s] of finished) if (now - s.finishedAt > FINISHED_TTL_MS) this.sessions.delete(id);
    const extra = this.sessions.size - MAX_SESSIONS;
    if (extra > 0) for (const [id] of finished.sort((a, b) => a[1].finishedAt - b[1].finishedAt).slice(0, extra)) this.sessions.delete(id);
  }

  async execute(owner, grant, {command, cwd, shell, tty = false, yield_ms = 1000, max_chars}) {
    if (!grant) throw Error('terminal access not granted');
    if (typeof command !== 'string') throw Error('command must be a string');
    if (!Number.isFinite(yield_ms) || yield_ms < 0 || typeof tty !== 'boolean') throw Error('invalid terminal options');
    cwd ??= grant.cwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw Error('cwd must be absolute');
    shell ??= process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const cmdShell = process.platform === 'win32' && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell);
    const args = cmdShell ? ['/d', '/s', '/c', '"' + command + '"'] : ['-c', command];
    const id = randomUUID();
    const session = {owner, text:'', head:0, delivered:0, exit_code:null, signal:null, done:false, finishedAt:0, listeners:new Set()};
    session.finished = new Promise(resolve => {session.finish = resolve;});
    const notify = () => { for (const f of [...session.listeners]) f(); };
    // Keep the tail: the end of a failing build is what the next decision needs.
    const append = text => {
      session.text += text;
      if (session.text.length > this.buffer) {
        const cut = session.text.length - this.buffer;
        session.text = session.text.slice(cut);
        session.head += cut;
      }
      notify();
    };
    const exited = (exit_code, signal) => {
      session.done = true; session.exit_code = exit_code; session.signal = signal ?? null;
      session.finishedAt = Date.now(); session.finish(); notify();
    };
    if (tty) {
      const child = pty.spawn(shell, cmdShell ? args.join(' ') : args, {cwd, env:process.env, name:'xterm-256color', cols:120, rows:30, useConptyDll:process.platform === 'win32'});
      session.write = text => child.write(text);
      session.kill = signal => {
        if (process.platform !== 'win32') child.kill(signal);
        else if (signal === 'SIGINT') child.write(INTERRUPT);
        else child.kill();
      };
      child.onData(append);
      child.onExit(({exitCode, signal}) => exited(exitCode, signal));
    } else {
      const child = spawn(shell, args, {cwd, env:process.env, windowsVerbatimArguments:cmdShell, detached:process.platform !== 'win32', stdio:'pipe'});
      session.write = text => child.stdin.write(text);
      session.kill = signal => {
        if (!child.pid) return;
        // Killing cmd.exe alone leaves its command alive and its pipes open on Windows.
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {stdio:'ignore'});
          killer.on('error', () => child.kill(signal));
        }
        // The group is gone once the child has exited and been reaped; macOS reports that
        // as EPERM rather than ESRCH, and neither is a failure to stop it.
        else { try { process.kill(-child.pid, signal); } catch (e) { if (!['ESRCH', 'EPERM'].includes(e.code)) throw e; } }
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', append);
      }
      child.stdin.on('error', () => {});
      child.on('error', error => append(error.message));
      child.on('close', (code, signal) => exited(code, signal));
    }
    this.prune();
    this.sessions.set(id, session);
    return this.read(owner, {session_id:id, yield_ms, max_chars});
  }

  async read(owner, {session_id, input = '', signal, yield_ms = 1000, cursor, max_chars}) {
    const s = this.sessions.get(session_id);
    if (!s || s.owner !== owner) throw Error('unknown terminal session');
    if (typeof input !== 'string' || !Number.isFinite(yield_ms) || yield_ms < 0) throw Error('invalid terminal input');
    if (signal && !['SIGINT','SIGTERM','SIGKILL'].includes(signal)) throw Error('invalid signal');
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) throw Error('cursor must be a non-negative integer');
    const limit = count(max_chars, DEFAULT_CHARS, MAX_CHARS, 'max_chars');
    if (!s.done && input) s.write(input);
    if (!s.done && signal) s.kill(signal);
    const waiting = () => s.head + s.text.length - Math.max(cursor ?? s.delivered, s.head);
    // Yield the HTTP call, not the command. A short command finishes inside this wait, so its
    // exit status comes back with its output instead of costing another round trip; a long one
    // returns what it has produced so far, and returns at once if a full reply is already waiting.
    if (!s.done && waiting() < limit && yield_ms > 0) await new Promise(resolve => {
      let timer;
      const finish = () => {clearTimeout(timer); s.listeners.delete(check); resolve();};
      const check = () => { if (s.done) finish(); };
      s.listeners.add(check);
      timer = setTimeout(finish, Math.min(yield_ms, 25000));
    });
    const asked = cursor ?? s.delivered;
    const start = Math.max(asked, s.head);
    const output = s.text.slice(start - s.head, start - s.head + limit);
    const next = start + output.length;
    s.delivered = Math.max(s.delivered, next);
    return {session_id, output, running:!s.done, exit_code:s.exit_code, signal:s.signal,
      cursor:next, more:s.head + s.text.length - next, dropped:start - asked};
  }

  async stop(owner) {
    const closing = [];
    for (const [id, s] of this.sessions) if (owner === undefined || s.owner === owner) {
      if (!s.done && !s.stopping) {s.stopping = true; s.kill('SIGKILL');}
      closing.push(s.finished.then(() => this.sessions.delete(id)));
    }
    await Promise.all(closing);
  }
}
