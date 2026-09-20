# The connection

One connection is one project. It exposes `read`, `apply_patch`, `exec_command` and `write_stdin`,
and nothing else: no task tokens, no result submission, no file CRUD beyond the patch envelope.

Commands inherit the worker user's OS access. The project is a default directory, **not a sandbox**:
other files, credentials, network services and programs that the user can reach are reachable.
This does not grant root or bypass OS privacy approvals. Read-only instructions are behavioural,
not enforced. `read` and `apply_patch` stay inside the project by design, which is a predictable
default rather than a security boundary — anything outside it is `exec_command`'s business, and the
same trust applies. Do not expose a connection to people you would not give a shell.

## Open, list, close

- `node <skill>/scripts/client.mjs open [/absolute/project]` — defaults to the current directory.
  Returns `id`, `project`, `connectionName`, `connectionUrl` (when `publicOrigin` is configured,
  `needsPublicOrigin` otherwise), `idleExpiresAt` and `reused`. The same project always gets the
  same live connection; reopening does not renew its lease, only terminal use does. Chats sharing a
  project share that connection. The URL is the capability: keep it out of chats, screenshots and
  reports. Expired or closed URLs stay revoked and return 404; a fresh session gets a new URL and
  name, so never repoint an old connection at a new project.
- `client.mjs status` — open projects, when each lease expires, whether a command is running.
  It never prints connection URLs.
- `client.mjs close <project|id>` — ends a session now and stops its commands.

## The tools

- `read(path, offset?, limit?, max_chars?)` reads a text file in the project. `offset` is the first
  line (1-based) and `limit` the number of lines; the reply reports `total_lines`, `end_line`,
  `eof` and whether the window was `truncated`. Binary files are reported, not dumped.
- `apply_patch(patch)` applies one envelope:
  `*** Begin Patch`, then `*** Add File: path` with `+` lines, `*** Update File: path` with optional
  `*** Move to: path` and `@@` sections of context, `-` and `+` lines, or `*** Delete File: path`,
  then `*** End Patch`. Context is matched exactly first, then ignoring trailing whitespace, then
  ignoring indentation; a `@@ header` line picks which copy of repeated context to use, and
  `*** End of File` anchors a section to the end. Either every file action applies or none does.
- `exec_command(command, cwd?, shell?, tty?, yield_ms?, max_chars?)` starts a command. `tty:true`
  gives a real PTY. It returns the first bounded slice of output, `session_id`, `cursor`, `more`,
  and `running`/`exit_code`. Nothing kills or truncates the command itself.
- `write_stdin(session_id, input?, signal?, cursor?, yield_ms?, max_chars?)` reads more output,
  sends input, or sends SIGINT/SIGTERM/SIGKILL. Continue where the last reply stopped, or pass an
  earlier `cursor` to re-read. HTTP calls yield within 25 seconds without stopping the command.
  Roughly a megabyte of recent output is kept per command; anything older is reported as `dropped`.
  Sessions end on exit, when the connection closes, or when the worker stops; they do not survive
  a worker restart.

There is no automatic undo and no revision checking. Respect project rules and preserve other work.
