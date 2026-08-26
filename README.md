# dsh-quick-commands

**[中文](./README.md) | [English](./README.en.md)**

DSH Web 插件：按工作区（workspace）管理快捷命令。为每个 DSH 工作区配置命名 shell 命令，从会话头部（Session log 左侧的 ▶ 快捷运行图标）点击即可运行，stdout/stderr 在浮动弹窗中实时显示。

## 安装

需要已安装 DSH（DeepSeek Harness）。以下命令通过 `dsh plugin` 在目标 profile 目录中转发给 pnpm 执行；目标 profile 首次使用时会自动初始化，安装完成后插件（声明了 `dsh.bundle`）会自动加入该 profile 的 bundles 层，重启 DSH（`dsh web`）后生效。

### 从 npm 安装

```bash
dsh plugin --profile web add @fonlan/dsh-quick-commands
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:fonlan/dsh-quick-commands
```

也可以固定到分支 / tag：

```bash
dsh plugin --profile web add github:fonlan/dsh-quick-commands#main
```

> 以 git 方式安装的插件会在安装时通过 `prepare` 脚本构建；如 pnpm 阻止了该构建，请按 pnpm 输出的提示，在 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 中加入对应的 key，然后重新执行上述命令。

### 卸载

```bash
dsh plugin --profile web remove @fonlan/dsh-quick-commands
```

卸载后该包会从 profile 的依赖与 bundles 层中移除，重启 DSH 后生效。

## 功能特性

- **设置卡片**（设置 → 插件配置 → Quick commands）：列出所有 DSH 工作区；在每个工作区下可新增 / 重命名 / 删除命令（名称 + 命令文本字段），每次编辑即时保存。
- **头部按钮**（会话头部，Session log 左侧）：列出当前工作区的命令（会话 cwd 匹配到工作区路径，包含子目录）。点击命令 → 在工作区目录中运行。
- **实时输出弹窗**：以约 200ms 的频率流式输出 stdout/stderr，分页签显示，纯文本，自动跟随滚动（手动滚动时暂停）；关闭 / 杀进程时按树形作用域终止；每个工作区串行执行（同一工作区同时只运行一个命令）。拖动左边框（宽度）和上 / 下边框（高度），或自由角手柄，即可调整大小；尺寸在多次运行与会话之间保持（持久化在插件设置中）。
- **远程（SSH）工作区**：当工作区是 `@dsh-ssh/dsh-ssh` 远程工作区（其路径为 `~/.dsh/remote/<hostId>/...` 下的本地占位符）时，快捷命令将流式传输到远程主机执行，而不是本地执行。命令菜单和运行弹窗会显示蓝色 **SSH** 徽标；当 SSH 主机未在 `dsh-ssh-hosts` 中配置时，连接会快速失败（附带可读的错误信息）。本地工作区不受影响——它们保持与之前完全一致的子进程行为。

## 配置

插件设置命名空间为 `quick-commands`：

```jsonc
{
  "workspaces": [
    { "workspaceId": "<dsh workspace id>", "commands": [
      { "name": "lint", "command": "npm run lint" },
      { "name": "test", "command": "npm test" }
    ]}
  ],
  "popupAnchor": "corner", // 或 "button"
  "popupSize": { "width": 520, "height": 340 } // 可选，用户拖动弹窗调整手柄时写入
}
```

### 占位符

| 占位符 | 值 |
| --- | --- |
| `{workspace}` | 工作区根路径（也是执行时的 cwd） |
| `{cwd}` | 会话的实际 cwd（可能是子目录） |
| `{title}` | 工作区显示标题 |

在远程工作区上，占位符解析为 *远程* 路径：`{workspace}` 和 `{cwd}` 为远程绝对路径（当会话 cwd 位于占位符工作区内时，会被重新锚定到远程文件系统），因此 `echo {cwd}` 打印的是远程目录。

### 环境变量

本地命令继承宿主进程环境，并额外设置：
`DSH_WORKSPACE`、`DSH_WORKSPACE_ID`、`DSH_WORKSPACE_TITLE`。
远程命令在 SSH 主机上以该主机的自身 shell 环境运行（远程侧不会注入 `DSH_*` 变量）。

### 远程执行细节

- 需要加载 `@dsh-ssh/dsh-ssh` 宿主插件（它提供 `sshPool` 服务和 `dsh-ssh-hosts` 设置命名空间）；缺失时，对远程占位符工作区执行的快捷命令会被明确拒绝并报错，而不是静默地在本地执行。
- 输出流通过 SSH 通道实时传输（相同的 tail/offset 轮询，弹窗不变）。杀进程会终止远程 **进程组**（`kill -TERM -- -<pgid>` 加 pkill 回退），因此 `sleep` / 构建器等子进程也会被覆盖。
- 远程命令前会加上一行探针标记以探测组 leader pid；弹窗显示的 stderr 中会过滤掉该行。
- 远程执行 shell：Linux / macOS 主机（bash 兼容），取决于 *远程* 主机的平台，而非本地主机。

## 安全模型

命令由用户配置、用户点击执行；不涉及模型请求、无审批提示、无沙箱限制。它们以宿主进程自身的 env/PATH 在主机上、工作区目录下执行。请只配置你信任的命令。远程命令以远程用户权限通过 SSH 执行；同样的信任原则适用，并加上远程主机暴露的一切。

## 平台

- 本地 macOS / Linux：`bash -c`
- 本地 Windows：`pwsh -c`（通过 `process.platform` 自动检测）
- 远程工作区：远程主机的 shell（Linux / macOS，如 `@dsh-ssh/dsh-ssh` 所支持）

## 开发

```bash
pnpm install
npm run build       # 宿主 tsc + 客户端 tsdown
node --experimental-strip-types --test test/remote.test.ts   # 远程单元测试
```

超级注入器流水线：在 DSH web profile 中使用 `dev_build_plugin` / `dev_inject_plugin`。

## License

MIT
