import { readText, applyPatch } from './files.mjs';

export const MAX_PATCH_CHARS = 1024 * 1024;

const str = {type: 'string'};
const num = {type: 'number'};
const schema = (properties, required) => ({type: 'object', properties, required, additionalProperties: false});

// One capability: develop in the connected project. A later optional capability — a browser,
// a desktop — is another module in the list the worker composes, enabled by configuration.
// It adds its own tools and its own call; nothing here reaches into it and nothing in the
// core depends on it existing.
export const localDevelopment = {
  name: 'local-development',
  tools: [
    {name: 'read',
      description: 'Read a text file in the connected project. Returns a bounded window: give offset (first line, 1-based) and limit (lines) to move through a long file. Reports total_lines and eof. Use exec_command for anything outside the project.',
      inputSchema: schema({path: str, offset: num, limit: num, max_chars: num}, ['path']),
      annotations: {readOnlyHint: true, openWorldHint: false}},
    {name: 'apply_patch',
      description: 'Create, edit, move or delete files in the connected project with one patch envelope: *** Begin Patch / *** Add File: path / *** Update File: path with @@ context and space, - and + lines / *** Move to: path / *** Delete File: path / *** End Patch. Every action is validated against the tree before anything is written, so a patch that does not fit changes nothing.',
      inputSchema: schema({patch: str}, ['patch']),
      annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}},
    {name: 'exec_command',
      description: 'Run a shell command with the local user’s own OS access: git, builds, tests, package managers, servers, network. cwd defaults to the connected project and is not a sandbox. tty:true gives a real interactive terminal. The command is never timed out or killed; only the reply is bounded, so when more is above zero read the rest with write_stdin and the returned cursor.',
      inputSchema: schema({command: str, cwd: str, shell: str, tty: {type: 'boolean'}, yield_ms: num, max_chars: num}, ['command']),
      annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true}},
    {name: 'write_stdin',
      description: 'Continue a command from exec_command: read more output, send input, or send SIGINT/SIGTERM/SIGKILL. An empty input just reads. Pass cursor to continue where the last reply stopped, or an earlier cursor to re-read. The command keeps running between calls.',
      inputSchema: schema({session_id: str, input: str, signal: {type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL']}, cursor: num, yield_ms: num, max_chars: num}, ['session_id'])},
  ],
  async call(name, args, {session, terminals}) {
    if (name === 'read') return readText(session.cwd, args);
    if (name === 'apply_patch') {
      if (typeof args.patch !== 'string') throw Error('patch must be a string');
      if (args.patch.length > MAX_PATCH_CHARS) throw Error('the patch is larger than ' + MAX_PATCH_CHARS + ' characters; send it in parts');
      return applyPatch(session.cwd, args.patch);
    }
    if (name === 'exec_command') return terminals.execute(session.id, {cwd: session.cwd}, args);
    if (name === 'write_stdin') return terminals.read(session.id, args);
    throw Error('unknown tool');
  },
  // Terminal output and file text are the bulk of what this connection sends back. Handing
  // them over as plain text keeps a build log from being paid for twice in JSON escapes.
  text(name, out) {
    if (name === 'read') {
      if (out.binary) return out.path + ' is not a text file (' + out.bytes + ' bytes)';
      return out.path + ' lines ' + out.start_line + '-' + out.end_line + ' of ' + out.total_lines
        + (out.truncated ? ' (window truncated)' : '') + '\n' + out.content;
    }
    if (name === 'apply_patch')
      return 'applied\n' + out.files.map(f => f.action + ' ' + f.path + (f.moved_to ? ' -> ' + f.moved_to : '')
        + ' +' + f.added + ' -' + f.removed).join('\n');
    const state = out.running ? 'running' : 'exit ' + (out.exit_code ?? 'signal ' + out.signal);
    const notes = [state, 'session ' + out.session_id, 'cursor ' + out.cursor];
    if (out.more) notes.push(out.more + ' more characters');
    if (out.dropped) notes.push(out.dropped + ' characters dropped past the buffer');
    return out.output + (out.output.endsWith('\n') || !out.output ? '' : '\n') + '[' + notes.join(', ') + ']';
  },
};

export const capabilities = [localDevelopment];
