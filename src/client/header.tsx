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
import type { QuickPopupSize } from '../shared/contract'

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
  const [menuRemoteHost, setMenuRemoteHost] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [anchor, setAnchor] = useState<'corner' | 'button'>('corner')
  const [popupSize, setPopupSize] = useState<QuickPopupSize | undefined>(undefined)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Click-outside dismissal: while the menu is open, a pointerdown on the
  // document that lands OUTSIDE the wrap (button / menu / run popup all live
  // inside the wrap) collapses the menu. pointerdown (not click) covers mouse,
  // touch and pen, and fires before the button's own click toggle.
  useEffect(() => {
    if (!popover.menuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      const wrap = wrapRef.current
      if (wrap === null) return
      if (e.target instanceof Node && wrap.contains(e.target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [popover.menuOpen])

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
        setMenuRemoteHost(own?.remoteHost ?? null)
        setAnchor(settings.popupAnchor)
        setPopupSize(settings.popupSize)
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
      openRun(run.runId, run.workspaceId, run.commandName, run.remoteHost)
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
    <div ref={wrapRef} className="qc-head-wrap">
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
            {menuRemoteHost !== null && <span className="qc-menu-remote" title={`SSH · ${menuRemoteHost}`}>SSH</span>}
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
          remoteHost={popover.remoteHost ?? undefined}
          t={t}
          anchor={anchor}
          popupSize={popupSize}
          sessionId={sessionId}
          onClose={closeRun}
        />
      )}
    </div>
  )
}

// ── popup drag-resize ───────────────────────────────────────────────────────
// The popup pins its RIGHT edge (both anchors), plus its BOTTOM edge (corner
// anchor) or TOP edge (button anchor, pinned below the button). So the MOVABLE
// borders are the LEFT border (width) and the TOP border (corner anchor) /
// BOTTOM border (button anchor) (height); the free corner (top-left /
// bottom-left) carries a diagonal grip for simultaneous two-axis resizing.
// Every handle follows the cursor edge-for-edge — pulling the left border LEFT
// widens, pulling the top border UP grows taller — nothing feels inverted.
// The size is clamped to viewport bounds and persisted to settings.

const POPUP_MIN_W = 320
const POPUP_MIN_H = 200
/** Total horizontal margin kept around the popup (both anchors). */
const POPUP_VIEWPORT_MARGIN = 40
/** Vertical space reserved for header/footer chrome (both anchors). */
const POPUP_VIEWPORT_RESERVED = 120

function popupDefaultSize(anchor: 'corner' | 'button'): QuickPopupSize {
  return anchor === 'corner' ? { width: 520, height: 340 } : { width: 440, height: 300 }
}

function popupClamp(size: QuickPopupSize): QuickPopupSize {
  const maxW = Math.max(POPUP_MIN_W, window.innerWidth - POPUP_VIEWPORT_MARGIN)
  const maxH = Math.max(POPUP_MIN_H, window.innerHeight - POPUP_VIEWPORT_RESERVED)
  return {
    width: Math.min(Math.max(POPUP_MIN_W, Math.round(size.width)), maxW),
    height: Math.min(Math.max(POPUP_MIN_H, Math.round(size.height)), maxH),
  }
}

/**
 * Initial popup size: the persisted one when it holds sane numbers, else the
 * per-anchor default. Defensive because schemastery resolves a MISSING object
 * field to `{}` (object schemas carry an implicit `default: {}`), so a
 * never-resized popup can arrive as `popupSize: {}` from settings.get().
 */
function popupSizeOrDefault(size: QuickPopupSize | undefined, anchor: 'corner' | 'button'): QuickPopupSize {
  if (
    size === undefined
    || !Number.isFinite(size.width)
    || !Number.isFinite(size.height)
    || size.width <= 0
    || size.height <= 0
  ) {
    return popupDefaultSize(anchor)
  }
  return popupClamp(size)
}

/** The streaming output popup. Polls stdout/stderr deltas every ~200ms. */
function RunPopup(props: {
  runId: string
  workspaceId: string
  commandName: string
  remoteHost?: string
  t: (key: string) => string
  anchor: 'corner' | 'button'
  popupSize?: QuickPopupSize
  sessionId: string
  onClose: () => void
}): JSX.Element {
  const { runId, t, anchor, remoteHost, onClose } = props
  const [size, setSize] = useState<QuickPopupSize>(() => popupSizeOrDefault(props.popupSize, anchor))
  // Mirrors `size` for drag handlers: pointer events can arrive faster than
  // React commits, so pointerup must read the latest value, not the render's.
  const sizeRef = useRef<QuickPopupSize>(size)
  const sizeDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startW: number
    startH: number
    /** Which handle started the drag (controls which axes move). */
    mode: 'left' | 'height' | 'corner'
  } | null>(null)
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
    // Already exited: there is nothing left to terminate, close directly
    // instead of asking "terminate this command?".
    if (state.status === 'exited') {
      onClose()
      return
    }
    setKillConfirm(true)
  }

  const confirmClose = (): void => {
    void kill()
  }

  // ── drag-resize: pointer capture on the handles keeps moving/cancelling
  // events flowing even when the cursor leaves the handle or the window.
  // Which border is free to move depends on the anchor: the corner anchor
  // pins bottom+right (top border moves for height), the button anchor pins
  // top+right (bottom border moves for height).
  const heightFree: 'top' | 'bottom' = anchor === 'corner' ? 'top' : 'bottom'

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault() // keep the handle from starting a text-selection gesture
    e.currentTarget.setPointerCapture(e.pointerId)
    sizeDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startW: sizeRef.current.width,
      startH: sizeRef.current.height,
      mode: e.currentTarget.dataset.resize as 'left' | 'height' | 'corner',
    }
  }

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = sizeDragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    const controlsW = drag.mode === 'left' || drag.mode === 'corner'
    const controlsH = drag.mode === 'height' || drag.mode === 'corner'
    const next = popupClamp({
      // Left border follows the cursor: dragging LEFT widens, RIGHT narrows.
      width: controlsW ? drag.startW - dx : drag.startW,
      // Top-free (corner): dragging UP grows. Bottom-free (button): DOWN grows.
      height: controlsH ? drag.startH + (heightFree === 'top' ? -dy : dy) : drag.startH,
    })
    sizeRef.current = next
    setSize(next)
  }

  const onResizePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = sizeDragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    sizeDragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Persist best-effort: a failed save just means the next popup reopens at
    // the default size (or the last successfully saved one).
    void quickApi.settingsSetPopupSize(sizeRef.current).catch(() => undefined)
  }

  /** Pointer-handler trio for one resize handle (mode = which axes it drives). */
  const resizeProps = (mode: 'left' | 'height' | 'corner') => ({
    'data-resize': mode,
    onPointerDown: onResizePointerDown,
    onPointerMove: onResizePointerMove,
    onPointerUp: onResizePointerUp,
    onPointerCancel: onResizePointerUp,
  })

  const active = state.status === 'running'
  const title = active ? `${props.commandName} · ${t('runStateRunning')}` : `${props.commandName} · ${t('runStateExited')} (${state.exitCode ?? '?'})`

  return (
    <div className={`qc-popup qc-popup-${anchor}`} role="dialog" aria-label={title} style={{ width: size.width, height: size.height }}>
      <header className="qc-popup-head">
        <span className="qc-popup-title" title={title}>{title}</span>
        {remoteHost !== undefined && <span className="qc-popup-remote" title={`SSH · ${remoteHost}`}>SSH</span>}
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

      {/* Resize handles: left border = width; top (corner anchor) / bottom
          (button anchor) border = height; free corner = diagonal grip. */}
      <div className="qc-popup-resize qc-popup-resize-left" title={t('runResize')} {...resizeProps('left')} />
      {heightFree === 'top'
        ? <div className="qc-popup-resize qc-popup-resize-top" title={t('runResize')} {...resizeProps('height')} />
        : <div className="qc-popup-resize qc-popup-resize-bottom" title={t('runResize')} {...resizeProps('height')} />}
      {heightFree === 'top' ? (
        <div className="qc-popup-resize qc-popup-resize-corner qc-popup-resize-corner-tl" title={t('runResize')} {...resizeProps('corner')}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M9 9 3 3 M9 5.5 5.5 3 M5.5 9 3 5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : (
        <div className="qc-popup-resize qc-popup-resize-corner qc-popup-resize-corner-bl" title={t('runResize')} {...resizeProps('corner')}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M9 3 3 9 M9 6.5 6.5 9 M5.5 3 3 5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  )
}
