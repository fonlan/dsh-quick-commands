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
  kill/close; serial per workspace (one run at a time per workspace).

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
  "popupAnchor": "corner" // or "button"
}
```

### Placeholders

| Placeholder | Value |
| --- | --- |
| `{workspace}` | workspace root path (also the execution cwd) |
| `{cwd}` | the session's actual cwd (may be a subdirectory) |
| `{title}` | workspace display title |

### Environment

Commands inherit the harness process environment plus:
`DSH_WORKSPACE`, `DSH_WORKSPACE_ID`, `DSH_WORKSPACE_TITLE`.

## Security model

Commands are user-configured and user-clicked; no model requests, no approval
prompts, no sandbox confinement. They execute with the harness process's own
env/PATH on the host machine under the workspace directory. Configure only
commands you trust.

## Platform

- macOS / Linux: `bash -c`
- Windows: `pwsh -c` (autodetect via `process.platform`)

## Development

```bash
pnpm install
npm run build       # host tsc + client tsdown
```

For the super-injector pipeline: `dev_build_plugin` / `dev_inject_plugin` from the
DSH web profile.

## License

MIT
