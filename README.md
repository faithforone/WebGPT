# WebGPT

**Let ChatGPT develop on your machine.** Connect a local project to your signed-in web ChatGPT:
it reads the code, edits files, runs the tests and tells you what happened. No file copying, no
pasting terminal output back and forth.

## Install

Paste this into Codex:

```text
Install https://github.com/Nhahan/WebGPT/tree/main/skills/webgpt
Follow the included references/setup.md and set up everything needed.
Handle installation, configuration and verification yourself; assume no setup knowledge.
I authorize the local worker and HTTPS forwarding, sharing its private connection
URL with my signed-in ChatGPT, and granting it full terminal access as my local
OS user for projects I open (the project folder is not a sandbox).
Ask only for sign-in or another action that genuinely requires me; continue afterward.
```

## Use

```text
webgpt open
```

```text
webgpt open /path/to/project
```

Codex opens a blank ChatGPT tab connected to that project and hands it to you. You start the
conversation — "look at this repo, add X, run the tests" — and ChatGPT does the work through the
connection. Access expires after 24 hours without use; each use resets the timer.

## What ChatGPT gets

| Tool | For |
| --- | --- |
| `read` | a bounded window of a file, so a big file cannot flood the conversation |
| `apply_patch` | create, edit, move or delete files in one all-or-nothing patch |
| `exec_command` | git, builds, tests, package managers, servers — as your OS user |
| `write_stdin` | keep reading a running command, answer its prompts, or stop it |

Commands are never truncated or timed out; only the replies are bounded and cursored.
The project directory is the default working directory, **not a sandbox**: a connection is
as trusted as a terminal. Only open projects on a machine you are willing to give ChatGPT.
