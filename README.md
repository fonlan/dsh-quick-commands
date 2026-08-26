# @fonlan/dsh-quick-commands

DSH web plugin: per-workspace quick commands. Configure named shell commands per DSH
workspace; run one from the session header (the ▶ quick-run icon left of the Session log pill)
and watch its stdout/stderr live in a floating popup.

## Features

- **Settings card** (设置 → 插件配置 → Quick commands): lists every DSH workspace;
  per workspace, add/rename/remove commands (name + command text fields), instant
  save per edit.
- **Header button** (session header, left of Session log): lists the current
  workspace's commands (session cwd matched to a workspace path, subdirectories
  included). Click a command → run it in the workspace directory.
- **Live output popup**: streams stdout/stderr at ~200 ms cadence, split tabs,
  raw text, auto-follow with manual-scroll pause; tree-scoped termination on
  kill/close; serial per workspace (one run at a time per workspace). Drag the
  left border (width) and the top/bottom border (height), or the free-corner
  grip, to resize; the size is remembered across runs and sessions (persisted
  in the plugin settings).
- **Remote (SSH) workspaces**: when the workspace is a `@dsh-ssh/dsh-ssh`
  remote workspace (its path is the local placeholder under
  `~/.dsh/remote/<hostId>/...`), quick commands stream over SSH on the remote
  host instead of the local machine. The command menu and the run popup show a
  blue **SSH** badge; the connection fails fast (with a readable error) when
  the SSH host is not configured in `dsh-ssh-hosts`. Local workspaces are
  untouched — they keep the exact pre-existing subprocess behaviour.

## Configuration

The plugin settings namespace is `quick-commands`:

```jsonc
{
  "workspaces": [
    { "workspaceId": "<dsh workspace id>", "commands": [
      { "name": "lint", "command": "npm run lint" },
      { "name": "test", "command": "npm test" }
    ]}
  ],
  "popupAnchor": "corner", // or "button"
  "popupSize": { "width": 520, "height": 340 } // optional, written when the user drags the popup's resize grip
}
```

### Placeholders

| Placeholder | Value |
| --- | --- |
| `{workspace}` | workspace root path (also the execution cwd) |
| `{cwd}` | the session's actual cwd (may be a subdirectory) |
| `{title}` | workspace display title |

On a remote workspace the placeholders resolve to *remote* paths: `{workspace}`
and `{cwd}` are the remote absolute paths (the session cwd is re-anchored onto
the remote filesystem when it sits inside the placeholder workspace), so
`echo {cwd}` prints the remote directory.

### Environment

Local commands inherit the harness process environment plus:
`DSH_WORKSPACE`, `DSH_WORKSPACE_ID`, `DSH_WORKSPACE_TITLE`.
Remote commands run on the SSH host with that host's own shell environment (the
`DSH_*` variables are not injected remotely).

### Remote execution details

- Requires the `@dsh-ssh/dsh-ssh` host plugin to be loaded (it provides the
  `sshPool` service and the `dsh-ssh-hosts` settings namespace); when absent,
  a quick command on a remote placeholder workspace is refused with an explicit
  error instead of silently running locally.
- Output streams live over the SSH channel (same tail/offset polling, popup
  unchanged). Kill terminates the remote **process group** (`kill -TERM -- -<pgid>`
  plus a pkill fallback), so children like `sleep`/builders are covered.
- A marker line is prefixed to the remote command to probe the group-leader
  pid; it is filtered out of the stderr the popup shows.
- Remote execution shells: Linux/macOS hosts (bash-compatible), the platform
  of the *remote* host, not the local one.

## Security model

Commands are user-configured and user-clicked; no model requests, no approval
prompts, no sandbox confinement. They execute with the harness process's own
env/PATH on the host machine under the workspace directory. Configure only
commands you trust. Remote commands execute with the remote user's privileges
over SSH; the same trust applies, plus anything the remote host exposes.

## Platform

- Local macOS / Linux: `bash -c`
- Local Windows: `pwsh -c` (autodetect via `process.platform`)
- Remote workspaces: the remote host's shell (Linux/macOS, as supported by
  `@dsh-ssh/dsh-ssh`)

## Development

```bash
pnpm install
npm run build       # host tsc + client tsdown
node --experimental-strip-types --test test/remote.test.ts   # remote unit tests
```

For the super-injector pipeline: `dev_build_plugin` / `dev_inject_plugin` from the
DSH web profile.

## License

MIT
