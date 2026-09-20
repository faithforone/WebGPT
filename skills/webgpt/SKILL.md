---
name: webgpt
description: Use for WebGPT requests, including open. Connect a local project to signed-in web ChatGPT so it can investigate, change and test that project itself.
---

# WebGPT

Connect one local project to the user's signed-in web ChatGPT and hand the conversation over.
ChatGPT does the development through that connection; this skill only sets it up.
Read [setup.md](references/setup.md) only for an installation request or an observed missing
capability. Normal use reads [workspace.md](references/workspace.md), not the worker source.

## Open a project

For `webgpt open [project path]` — and for any request to work on a project in ChatGPT — use the
named project or the current directory. The request already authorizes creating the project's
connection, sharing its private URL with signed-in ChatGPT and accepting the matching connection
dialogs. Do not ask for consent again; ask only for something the user must do personally, such as
signing in.

Run `node <skill>/scripts/client.mjs open [project path]` once. It returns a stable connection name
and a privately usable URL, reusing a live connection for the same project without renewing its
lease. Open a new tab and select the returned connection name in the composer plugin menu. If it is
already registered, hand over immediately: no setup reads, re-registration, process scans, probes or
worker restart. Only if it is absent, register that exact name and URL through setup.md's connection
steps, then select it. If `needsPublicOrigin` is returned, resolve the existing forwarding origin
once and save `publicOrigin` in the worker config; do not search old notes or change the tunnel.
Never repoint an existing connection to a new session. Expired sessions receive fresh names and URLs.

Preserve the current model unless the user specified one. Do not type or send any message, task or
probe: the user starts the conversation. Verify the selected connection and the absence of sent
messages, mark the tab as a deliverable using the browser's supported keep-open mechanism, and hand
it over. If connection setup fails, cancel only a newly created session (`reused:false`), never a
reused one; report the failure and never substitute an unconnected tab.

Stop after handover. There is no waiting, no collection, no result file, no backup check, no chat
deletion and no tab closure. The user may send unlimited messages in that chat, and may open other
chats on the same connection.

The local worker, not this skill, expires access after 24 hours without terminal use, checked within
a minute; each tool call renews it and running commands are protected. Expiry never deletes chats,
tabs or project files.

## What the connection gives ChatGPT

Four tools, bound to that one project: `read`, `apply_patch`, `exec_command`, `write_stdin`.
Files are read in bounded windows and edited with patch envelopes; everything else — git, builds,
tests, package managers, servers — is the shell. Replies are bounded and cursored so a long build
cannot flood the conversation; the commands themselves are never truncated or timed out.
Commands run as the local OS user. The project is the default directory, **not a sandbox**.

## Keep out of scope

- Do not do the user's development yourself in Codex when they asked to work in ChatGPT.
- Do not put the connection URL in a chat message, a screenshot, a report or a log.
- Do not build task registration, supervision, progress polling, ledgers or cleanup automation
  around this connection. It is a live connection, not a delegation pipeline.
- Do not add browser or desktop control here. If such a capability is ever installed, it is a
  separate, separately authorized connector.

Use `client.mjs status` to list open projects and `client.mjs close <project>` to end one early.
