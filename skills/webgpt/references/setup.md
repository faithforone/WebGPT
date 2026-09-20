# Setup

Install and verify a real ChatGPT-to-project connection. Honour the user's Install authorization;
ask only for something that genuinely requires them, such as signing in. `webgpt open` already
authorizes creating its project connection, sharing its private URL with ChatGPT and accepting the
matching dialogs. Preserve unrelated services, tabs and configuration.

## Install

Resolve the branch in the user's URL to a commit and install `skills/webgpt` at that commit using
Codex's skill installer. Record the revision privately. Preserve customized installations unless
replacement was requested. Before replacing scripts, stop only the identified idle WebGPT worker;
preserve its data and credentials, and never stop a worker with a running command.

Use Node.js 22+. Run `npm ci` and `npm test` inside the installed skill directory. Install missing
prerequisites from official sources. `node-pty` supplies the real PTY; if a prebuilt is unavailable,
install its documented native build prerequisites.

## Worker

Read [workspace.md](workspace.md). A connection grants full terminal access as the OS user, and the
project directory is not a sandbox. The README Install prompt authorizes this.

Worker and client share an optional `~/.config/webgpt/config.json`:

```json
{
  "dataDir": "/absolute/private/webgpt-data",
  "mcpPort": 43137,
  "controlPort": 43139,
  "publicOrigin": "https://forwarded.example.com"
}
```

Defaults: `~/.local/share/webgpt`, ports 43137 and 43139. `WEBGPT_CONFIG` selects another config and
`WEBGPT_DATA_DIR` overrides the data directory, so a second, independent worker is a matter of a
second config with its own ports. Keep config and data outside projects and outside the installed
skill, protected by POSIX mode 0700 or private Windows ACLs. Never print keys or connection URLs.

Check port ownership; do not displace another process. Start `node <installed-skill>/scripts/worker.mjs`,
then verify its ready output, `GET /health` on the MCP port, and `client.mjs status`. Use the OS
service manager for persistence after Codex exits, and record the owned service. Keep the same data
directory. Before recovering `worker.lock/owner.json`, verify its host and PID are no longer using it.

The MCP port serves exactly two things: `/health`, and one unguessable path per open project. Every
other path returns 404, and a request carrying a browser `Origin` header is refused.

## ChatGPT connection

The connection must reach the worker through a credentialed tunnel. A direct address — the
loopback port, a LAN address, a forwarded port on the router — is not an operational path, and
`publicOrigin` refuses one. An ephemeral quick tunnel is for a lab, not for use: its hostname
changes on every restart, which is the same stale-URL failure by another name. No OpenAI Platform
login, API key, organization role or paid account is needed.

1. Reuse the tunnel that already exists on the machine. Add one hostname for this worker to its
   ingress rules, above the catch-all, and leave every existing rule untouched:

   ```yaml
   ingress:
     - hostname: <existing>
       service: http://127.0.0.1:<existing port>
     - hostname: <new hostname for this worker>
       service: http://127.0.0.1:<this worker's mcpPort>
     - service: http_status:404
   ```

   Back the file up first, then check it with `cloudflared --config <file> tunnel ingress validate`
   and `... tunnel ingress rule <url>` before applying anything. Route the new hostname to the same
   tunnel (`cloudflared tunnel route dns <tunnel> <hostname>`), which adds one proxied DNS record.
   Applying the change restarts the tunnel process under its service manager, so both hostnames are
   briefly unreachable: do it while nothing is mid-call. Do not put an access policy in front of the
   hostname — the connection carries no OAuth and would simply be refused.

2. Save that hostname as `publicOrigin` in this worker's config, origin only, no path. Each worker
   has its own config file, so two workers on one machine never share an origin.

3. Run `client.mjs open /absolute/project`. It checks that the origin really answers as this worker
   before writing anything: a rerouted or restarted tunnel is refused here rather than by a
   connection that returns 404 to a conversation. It prints the connection name and where the URL
   was written, and never prints the URL itself.

4. Register that name and URL in ChatGPT's connectors as a URL connection with no OAuth, reading
   the URL out of `<dataDir>/connection.json` straight into the form. Refresh discovery and verify
   `read`, `apply_patch`, `exec_command` and `write_stdin`, with no task, result or CRUD tools left
   from another worker. Preserve other connectors; never repoint an existing one.

The URL is this machine's shell in a link. It belongs in that file and in the connector form, never
in a chat message, a screenshot, a report, a log or a command line.

## End-to-end test

The installation is finished when a new ChatGPT conversation on a connected project can carry a
single request of the form "investigate this repository, implement X, and test it" from start to
finish: reading the code, editing files, running the project's own tests and reporting, with no file
pasted and no terminal output relayed by hand. Use a small, real change in a throwaway project, not
a printed value.

Verify afterwards from the machine's side: the change is in the working tree, the test command the
model claims to have run really ran, and `client.mjs status` shows the project with a renewed lease.
A completion claim in chat is not evidence.

Save a compact private setup note with the installed path and revision, config path, owned worker and
tunnel services, connection name and PASS/FAIL/NOT_RUN evidence, without credentials. On interruption,
record the exact next action and resume the same installation.
