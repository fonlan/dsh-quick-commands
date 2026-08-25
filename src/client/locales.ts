/**
 * Client dictionary namespace for @fonlan/dsh-quick-commands.
 */
export const LOCALE_NS = 'quick-commands'

export const zh = {
  // header button
  buttonTitle: '快速命令',
  buttonTooltip: '快速命令（当前工作区）',
  noWorkspace: '当前会话不在任何已配置的工作区中',
  noCommands: '当前工作区未配置命令',
  openSettings: '去设置配置命令',

  // command popup menu
  menuTitle: '快速命令',
  menuEmpty: '（无命令）',

  // run popup
  runTitle: '运行中',
  runExited: '已退出',
  runExitCode: '退出码',
  runSignal: '信号',
  runStdout: '输出 (stdout)',
  runStderr: '错误 (stderr)',
  runEmpty: '（无输出）',
  runCommand: '命令',
  runCwd: '工作区',
  runStateRunning: '运行中…',
  runStateExited: '已退出',
  runKill: '终止',
  runClose: '关闭',
  runKillConfirm: '终止后输出弹窗将关闭，确定终止该命令？',
  runBusy: '该工作区已有命令在运行',
  runStartFailed: '命令启动失败',
  runPollFailed: '输出读取失败',
  runLost: '运行记录已失效',
  runNotFound: '工作区或命令未找到',

  // settings card
  cardTitle: '快速命令',
  cardDescription: '为每个工作区配置常用命令，会话头部一键运行',
  collapseOrExpand: '展开 / 收起',
  cardIntro: '为每个工作区配置常用命令，运行于工作区目录。支持占位符：{workspace} 工作区路径，{cwd} 会话目录，{title} 工作区标题。',
  cardWorkspaces: '工作区',
  cardNoWorkspaces: '没有工作区。请在侧边栏先添加工作区。',
  cardCommands: '命令',
  cardNoCommands: '未配置命令',
  cardAddCommand: '添加命令',
  cardName: '名称',
  cardCommand: '命令',
  cardRemove: '删除',
  cardSaveError: '保存失败',
  cardAnchor: '输出弹窗位置',
  cardAnchorCorner: '右下角',
  cardAnchorButton: '锚定按钮下方',
}

export const en = {
  buttonTitle: 'Quick commands',
  buttonTooltip: 'Quick commands (current workspace)',
  noWorkspace: 'This session is not in any configured workspace',
  noCommands: 'No commands configured for this workspace',
  openSettings: 'Configure commands in Settings',

  menuTitle: 'Quick commands',
  menuEmpty: '(no commands)',

  runTitle: 'Running',
  runExited: 'Exited',
  runExitCode: 'Exit code',
  runSignal: 'Signal',
  runStdout: 'Output (stdout)',
  runStderr: 'Errors (stderr)',
  runEmpty: '(no output)',
  runCommand: 'Command',
  runCwd: 'Workspace',
  runStateRunning: 'Running…',
  runStateExited: 'Exited',
  runKill: 'Terminate',
  runClose: 'Close',
  runKillConfirm: 'Terminating closes the output popup. Terminate this command?',
  runBusy: 'A command is already running for this workspace',
  runStartFailed: 'Command failed to start',
  runPollFailed: 'Failed to read output',
  runLost: 'Run record expired',
  runNotFound: 'Workspace or command not found',

  cardTitle: 'Quick commands',
  cardDescription: 'Configure common commands per workspace, run them from the session header',
  collapseOrExpand: 'Expand / collapse',
  cardIntro: 'Configure common commands per workspace; they run in the workspace directory. Placeholders: {workspace} workspace path, {cwd} session cwd, {title} workspace title.',
  cardWorkspaces: 'Workspaces',
  cardNoWorkspaces: 'No workspaces. Add one in the sidebar first.',
  cardCommands: 'Commands',
  cardNoCommands: 'No commands configured',
  cardAddCommand: 'Add command',
  cardName: 'Name',
  cardCommand: 'Command',
  cardRemove: 'Remove',
  cardSaveError: 'Save failed',
  cardAnchor: 'Output popup position',
  cardAnchorCorner: 'Bottom right',
  cardAnchorButton: 'Anchored at button',
}
