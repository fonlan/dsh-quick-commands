/**
 * Session-header quick-command surface: the ▶ play icon button (left of the
 * Session log pill), the command menu popover (current workspace's commands),
 * and the live output popup that streams stdout/stderr at ~200ms cadence.
 *
 * Props are the standard session/global kit of `conversation.session.header.utilities`
 * plus this plugin's injected hooks (anchor preference + resolver).
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconPlayOutline16,
  IconCloseOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { quickApi } from './api'
import { useRunPopover, openMenu, closeMenu, openRun, closeRun } from './run-state'

/** Workspace row shape the standard useWorkspaces hook exposes. */
interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
}

/** Session list state subset we read (cwd + id). */
interface SessionRow {
  id: string
  cwd?: string
}

interface HeaderProps {
  sessionId: string
  t: (key: string) => string
  useSessions?: (selector: (s: { byId: Record<string, SessionRow>; current?: string }) => unknown) => unknown
  useWorkspaces?: (selector: (s: { items: WorkspaceRow[] }) => unknown) => unknown
}

/** Longest-path workspace match for a cwd (subdirectory allowed). */
function matchWorkspace(cwd: string | undefined, workspaces: WorkspaceRow[]): WorkspaceRow | undefined {
  if (cwd === undefined) return undefined
  let best: WorkspaceRow | undefined
  for (const ws of workspaces) {
    const norm = ws.path.replace(/\\/g, '/').replace(/\/+$/, '')
    const nc = cwd.replace(/\\/g, '/')
    if (nc === norm || nc.startsWith(norm + '/')) {
      if (best === undefined || norm.length > best.path.length) best = ws
    }
  }
  return best
}

/** Resolve the current session's workspace from the standard kits. */
function useCurrentWorkspace(
  sessionId: string,
  useSessions?: HeaderProps['useSessions'],
  useWorkspaces?: HeaderProps['useWorkspaces'],
): { workspace: WorkspaceRow | undefined; cwd: string | undefined } {
  const row = useSessions?.((s) => s.byId[sessionId]) as SessionRow | undefined
  const workspaces = useWorkspaces?.((s) => s.items) as WorkspaceRow[] | undefined
  return { workspace: matchWorkspace(row?.cwd, workspaces ?? []), cwd: row?.cwd }
}

/** Header icon button + command menu + live output popup. */
export function QuickCommandsHeaderAction(props: HeaderProps): JSX.Element {
  const { sessionId, t } = props
  const { workspace, cwd } = useCurrentWorkspace(sessionId, props.useSessions, props.useWorkspaces)
  const popover = useRunPopover()
  const [commands, setCommands] = useState<Array<{ name: string; command: string }>>([])
  const [menuLoadError, setMenuLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [anchor, setAnchor] = useState<'corner' | 'button'>('corner')

  // Load the workspace's command list + anchor when the menu opens.
  useEffect(() => {
    if (!popover.menuOpen) return
    let cancelled = false
    void (async () => {
      try {
        const [entries, settings] = await Promise.all([quickApi.workspacesList(), quickApi.settingsGet()])
        if (cancelled) return
        const own = entries.find((e) => e.workspaceId === workspace?.workspaceId)
        setCommands(own === undefined ? [] : own.commands)
        setAnchor(settings.popupAnchor)
        setMenuLoadError(null)
      } catch (e) {
        if (cancelled) return
        setCommands([])
        setMenuLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [popover.menuOpen, workspace?.workspaceId])

  const startRun = async (commandName: string): Promise<void> => {
    setBusy(true)
    closeMenu()
    try {
      const run = await quickApi.runStart(workspace!.workspaceId, commandName, cwd ?? workspace!.path)
      openRun(run.runId, workspace!.workspaceId, run.commandName)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message.includes('run-busy') || message.includes('already running')) {
        setMenuLoadError(t('runBusy'))
      } else {
        setMenuLoadError(t('runStartFailed') + ': ' + message)
      }
      openMenu()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="qc-head-wrap">
      <button
        type="button"
        className="qc-head-btn"
        title={workspace === undefined ? t('noWorkspace') : t('buttonTooltip')}
        aria-label={t('buttonTitle')}
        disabled={workspace === undefined}
        onClick={() => { popover.menuOpen ? closeMenu() : openMenu() }}
      >
        <IconPlayOutline16 size={16} />
      </button>

      {popover.menuOpen && workspace !== undefined && (
        <div className="qc-menu" role="menu">
          <div className="qc-menu-head">
            <span className="qc-menu-title">{t('menuTitle')}</span>
            <span className="qc-menu-ws">{workspace.title}</span>
            <button type="button" className="qc-menu-close" aria-label={t('runClose')} onClick={closeMenu}>
              <IconCloseOutline16 size={12} />
            </button>
          </div>
          {commands.length === 0 && (
            <p className="qc-menu-empty">{menuLoadError ?? t('noCommands')}</p>
          )}
          {commands.filter((c) => c.name.trim() !== '').map((command) => (
            <button
              key={command.name}
              type="button"
              role="menuitem"
              className="qc-menu-item"
              disabled={busy}
              onClick={() => void startRun(command.name)}
            >
              <span className="qc-menu-item-name">{command.name}</span>
              <span className="qc-menu-item-cmd">{command.command}</span>
            </button>
          ))}
        </div>
      )}

      {popover.runId !== null && (
        <RunPopup
          runId={popover.runId}
          workspaceId={popover.workspaceId ?? ''}
          commandName={popover.commandName ?? ''}
          t={t}
          anchor={anchor}
          sessionId={sessionId}
          onClose={closeRun}
        />
      )}
    </div>
  )
}

/** The streaming output popup. Polls stdout/stderr deltas every ~200ms. */
function RunPopup(props: {
  runId: string
  workspaceId: string
  commandName: string
  t: (key: string) => string
  anchor: 'corner' | 'button'
  sessionId: string
  onClose: () => void
}): JSX.Element {
  const { runId, t, anchor, onClose } = props
  const [state, setState] = useState(() => ({
    status: 'running' as 'running' | 'exited',
    exitCode: null as number | null,
    signal: null as string | null,
    stdoutEnd: 0,
    stderrEnd: 0,
    stdout: '',
    stderr: '',
    stdoutLossy: false,
    stderrLossy: false,
  }))
  const [view, setView] = useState<'stdout' | 'stderr'>('stdout')
  const [autoFollow, setAutoFollow] = useState(true)
  const [killConfirm, setKillConfirm] = useState(false)
  const [pollError, setPollError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const outputRef = useRef<HTMLDivElement | null>(null)
  const autoFollowRef = useRef(true)

  // Auto-follow: scroll the output pane to the bottom on new output while the
  // user has not scrolled up (autoFollow mirror keeps the effect cheap).
  useEffect(() => {
    autoFollowRef.current = autoFollow
  }, [autoFollow])
  useEffect(() => {
    if (!autoFollowRef.current) return
    const el = outputRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [state.stdout, state.stderr, view])

  // Poll deltas; stop polling at exit (the run stays readable in memory).
  useEffect(() => {
    let cancelled = false
    let outEnd = 0
    let errEnd = 0
    const tick = async (): Promise<void> => {
      try {
        const poll = await quickApi.runPoll(runId, outEnd, errEnd)
        if (cancelled) return
        outEnd = poll.stdoutEnd
        errEnd = poll.stderrEnd
        setState((s) => ({
          status: poll.status,
          exitCode: poll.exitCode,
          signal: poll.signal,
          stdoutEnd: poll.stdoutEnd,
          stderrEnd: poll.stderrEnd,
          stdout: poll.stdoutLossy ? poll.stdoutDelta : s.stdout + poll.stdoutDelta,
          stderr: poll.stderrLossy ? poll.stderrDelta : s.stderr + poll.stderrDelta,
          stdoutLossy: poll.stdoutLossy,
          stderrLossy: poll.stderrLossy,
        }))
        setPollError(null)
        if (poll.status === 'exited') return
        timer = window.setTimeout(() => void tick(), 200)
      } catch (e) {
        if (cancelled) return
        setPollError(e instanceof Error ? e.message : String(e))
        timer = window.setTimeout(() => void tick(), 500)
      }
    }
    let timer: number
    void tick()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [runId])

  const kill = async (): Promise<void> => {
    setClosing(true)
    try {
      await quickApi.runKill(runId)
    } finally {
      onClose()
    }
  }

  const close = (): void => {
    setKillConfirm(true)
  }

  const confirmClose = (): void => {
    void kill()
  }

  const active = state.status === 'running'
  const title = active ? `${props.commandName} · ${t('runStateRunning')}` : `${props.commandName} · ${t('runStateExited')} (${state.exitCode ?? '?'})`

  return (
    <div className={`qc-popup qc-popup-${anchor}`} role="dialog" aria-label={title}>
      <header className="qc-popup-head">
        <span className="qc-popup-title" title={title}>{title}</span>
        <span className="qc-popup-cmd">{props.commandName}</span>
        <button
          type="button"
          className="qc-popup-icon qc-popup-kill"
          disabled={!active || closing}
          title={t('runKill')}
          aria-label={t('runKill')}
          onClick={() => void kill()}
        >
          <IconStopFill16 size={14} />
        </button>
        <button
          type="button"
          className="qc-popup-icon qc-popup-close"
          title={t('runClose')}
          aria-label={t('runClose')}
          onClick={close}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </header>

      {killConfirm && (
        <div className="qc-popup-confirm">
          <span>{t('runKillConfirm')}</span>
          <button type="button" className="qc-popup-btn" onClick={confirmClose}>{t('runKill')}</button>
          <button type="button" className="qc-popup-btn qc-popup-btn-plain" onClick={() => setKillConfirm(false)}>
            {t('runClose')}
          </button>
        </div>
      )}

      <div className="qc-popup-tabs">
        <button
          type="button"
          className={'qc-popup-tab' + (view === 'stdout' ? ' qc-popup-tab-active' : '')}
          onClick={() => setView('stdout')}
        >
          {t('runStdout')}
        </button>
        <button
          type="button"
          className={'qc-popup-tab' + (view === 'stderr' ? ' qc-popup-tab-active' : '')}
          onClick={() => setView('stderr')}
        >
          {t('runStderr')}
        </button>
      </div>

      <div
        ref={outputRef}
        className="qc-popup-output"
        onScroll={(e) => {
          const el = e.currentTarget
          const atEnd = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 24
          setAutoFollow(atEnd)
        }}
      >
        {pollError !== null && <p className="qc-popup-error">{t('runPollFailed')}: {pollError}</p>}
        {view === 'stdout' ? (
          state.stdout === '' && !active ? <p className="qc-popup-empty">{t('runEmpty')}</p>
            : <pre className="qc-popup-pre">{state.stdout}</pre>
        ) : (
          state.stderr === '' && !active ? <p className="qc-popup-empty">{t('runEmpty')}</p>
            : <pre className="qc-popup-pre">{state.stderr}</pre>
        )}
      </div>

      <footer className="qc-popup-foot">
        <span className="qc-popup-state">
          {active ? t('runStateRunning') : `${t('runStateExited')} · ${t('runExitCode')} ${state.exitCode ?? '-'}${state.signal !== null ? ` · ${state.signal}` : ''}`}
        </span>
      </footer>
    </div>
  )
}
