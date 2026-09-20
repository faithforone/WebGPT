import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Reading and patching are the two things a shell does badly from a chat: `cat` spends the
// conversation's context on a whole file, and heredoc rewrites lose to quoting. Everything
// else — git, builds, test runners, servers — stays in the terminal.
export const READ_LINES = 400;
export const READ_CHARS = 16000;
export const MAX_READ_LINES = 5000;
export const MAX_READ_CHARS = 200000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// The project is the file tools' world. The terminal is deliberately not restricted this
// way, so this is a predictable default, not a security boundary, and it is documented
// as one: anything outside the project is exec_command's business.
export function projectRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('the project path must be absolute');
  const cwd = realpathSync(path);
  if (!statSync(cwd).isDirectory()) throw Error('the project path must be a directory');
  return { cwd };
}

export function inside(root, path) {
  if (typeof path !== 'string' || !path.trim()) throw Error('path must be a non-empty string');
  const full = resolve(root, path);
  let existing = full, rest = '';
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest = rest ? join(basename(existing), rest) : basename(existing);
    existing = dirname(existing);
  }
  const real = rest ? join(realpathSync(existing), rest) : realpathSync(existing);
  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error('path is outside the connected project: ' + path);
  return { full: real, rel };
}

function count(value, fallback, limit, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > limit) throw Error(name + ' must be an integer between 1 and ' + limit);
  return value;
}

export function readText(root, {path, offset = 1, limit, max_chars}) {
  const { full, rel } = inside(root, path);
  const stat = statSync(full);
  if (stat.isDirectory()) throw Error(rel + ' is a directory; list it with exec_command');
  if (stat.size > MAX_FILE_BYTES) throw Error(rel + ' is larger than ' + MAX_FILE_BYTES + ' bytes; read parts of it with exec_command');
  const lineLimit = count(limit, READ_LINES, MAX_READ_LINES, 'limit');
  const charLimit = count(max_chars, READ_CHARS, MAX_READ_CHARS, 'max_chars');
  if (!Number.isInteger(offset) || offset < 1) throw Error('offset must be a line number of 1 or more');
  const bytes = readFileSync(full);
  if (bytes.includes(0)) return {path: rel, binary: true, bytes: bytes.length};
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const window = lines.slice(offset - 1, offset - 1 + lineLimit);
  let content = window.join('\n'), shown = window.length, truncated = window.length < lines.length - (offset - 1);
  while (content.length > charLimit && shown > 1) {
    shown--; truncated = true;
    content = window.slice(0, shown).join('\n');
  }
  if (content.length > charLimit) { content = content.slice(0, charLimit); truncated = true; }
  const end = offset - 1 + shown;
  return {path: rel, start_line: offset, end_line: end, total_lines: lines.length,
    eof: end >= lines.length, truncated, content};
}

// The apply_patch envelope, as the models already write it.
export function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch.trim()) throw Error('patch must be a non-empty string');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines[0] !== '*** Begin Patch') throw Error('the patch must start with *** Begin Patch');
  if (lines[lines.length - 1] !== '*** End Patch') throw Error('the patch must end with *** End Patch');
  const ops = [];
  const end = lines.length - 1;
  let i = 1;
  while (i < end) {
    const line = lines[i++];
    let match;
    if ((match = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const body = [];
      while (i < end && !lines[i].startsWith('*** ')) {
        const text = lines[i++];
        if (!text.startsWith('+')) throw Error('every line of an added file must start with +: ' + text);
        body.push(text.slice(1));
      }
      ops.push({action: 'add', path: match[1].trim(), body});
    } else if ((match = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({action: 'delete', path: match[1].trim()});
    } else if ((match = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const op = {action: 'update', path: match[1].trim(), hunks: []};
      if (i < end && lines[i].startsWith('*** Move to: ')) op.move = lines[i++].slice('*** Move to: '.length).trim();
      let hunk = null;
      while (i < end && !/^\*\*\* (Add|Delete|Update) File: /.test(lines[i])) {
        const text = lines[i++];
        if (text.startsWith('@@')) { hunk = {header: text.slice(2).trim(), lines: [], eof: false}; op.hunks.push(hunk); continue; }
        if (text === '*** End of File') {
          if (!hunk) throw Error('*** End of File before any change in ' + op.path);
          hunk.eof = true; continue;
        }
        if (text.startsWith('*** ')) throw Error('unexpected patch line: ' + text);
        if (!hunk) { hunk = {header: '', lines: [], eof: false}; op.hunks.push(hunk); }
        // A context line may arrive as a bare empty line rather than a single space.
        if (text === '') hunk.lines.push({kind: ' ', text: ''});
        else if (' +-'.includes(text[0])) hunk.lines.push({kind: text[0], text: text.slice(1)});
        else throw Error('a change line must start with a space, + or -: ' + text);
      }
      if (!op.hunks.some(h => h.lines.length)) throw Error('no changes given for ' + op.path);
      ops.push(op);
    } else throw Error('unexpected patch line: ' + line);
  }
  if (!ops.length) throw Error('the patch contains no file actions');
  return ops;
}

const SAME = [
  (a, b) => a === b,
  (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, ''),
  (a, b) => a.trim() === b.trim(),
];

function locate(lines, from, before, header) {
  if (!before.length) return from;
  const scan = start => {
    for (const same of SAME) {
      for (let at = start; at + before.length <= lines.length; at++) {
        let ok = true;
        for (let j = 0; j < before.length && ok; j++) ok = same(lines[at + j], before[j]);
        if (ok) return at;
      }
    }
    return -1;
  };
  if (header) {
    const anchor = lines.findIndex((line, index) => index >= from && (line === header || line.trim() === header.trim()));
    if (anchor >= 0) {
      const found = scan(anchor);
      if (found >= 0) return found;
    }
  }
  return scan(from);
}

export function applyHunks(original, op) {
  const ending = original.endsWith('\n');
  const lines = original.split('\n');
  if (ending) lines.pop();
  const out = [];
  let index = 0, added = 0, removed = 0;
  for (const [n, hunk] of op.hunks.entries()) {
    const before = hunk.lines.filter(line => line.kind !== '+').map(line => line.text);
    let at;
    if (hunk.eof && before.length) {
      at = lines.length - before.length;
      if (at < index || locate(lines.slice(at), 0, before, '') !== 0) at = -1;
    } else at = locate(lines, index, before, hunk.header);
    if (at < 0) throw Error('change ' + (n + 1) + ' of ' + op.path + ' does not match the file; it expects: '
      + JSON.stringify(before.slice(0, 3)));
    out.push(...lines.slice(index, at));
    let offset = 0;
    for (const line of hunk.lines) {
      if (line.kind === '+') { added++; out.push(line.text); continue; }
      if (line.kind === '-') removed++;
      // A context line is not a change: keep the file's own line, whitespace and all.
      else out.push(lines[at + offset]);
      offset++;
    }
    index = at + offset;
  }
  out.push(...lines.slice(index));
  return {text: out.join('\n') + (ending || !original ? '\n' : ''), added, removed};
}

// Nothing is written until every file action has been resolved against the tree.
export function applyPatch(root, patch) {
  const ops = parsePatch(patch);
  const seen = new Set(), writes = [], removals = [], files = [];
  for (const op of ops) {
    const { full, rel } = inside(root, op.path);
    if (seen.has(full)) throw Error('the patch touches ' + rel + ' twice');
    seen.add(full);
    if (op.action === 'add') {
      if (existsSync(full)) throw Error(rel + ' already exists; update it instead of adding it');
      writes.push({full, text: op.body.join('\n') + (op.body.length ? '\n' : '')});
      files.push({path: rel, action: 'added', added: op.body.length, removed: 0});
    } else if (op.action === 'delete') {
      if (!existsSync(full)) throw Error(rel + ' does not exist');
      const lines = readFileSync(full, 'utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      removals.push(full);
      files.push({path: rel, action: 'deleted', added: 0, removed: lines.length});
    } else {
      if (!existsSync(full)) throw Error(rel + ' does not exist');
      const result = applyHunks(readFileSync(full, 'utf8'), {...op, path: rel});
      const target = op.move ? inside(root, op.move) : {full, rel};
      if (op.move) {
        if (seen.has(target.full)) throw Error('the patch touches ' + target.rel + ' twice');
        if (existsSync(target.full)) throw Error(target.rel + ' already exists');
        seen.add(target.full);
        removals.push(full);
      }
      writes.push({full: target.full, text: result.text});
      files.push({path: rel, action: op.move ? 'moved' : 'updated', added: result.added,
        removed: result.removed, ...(op.move ? {moved_to: target.rel} : {})});
    }
  }
  for (const write of writes) {
    mkdirSync(dirname(write.full), {recursive: true});
    writeFileSync(write.full, write.text);
  }
  for (const path of removals) rmSync(path, {force: true});
  return {applied: true, files};
}
