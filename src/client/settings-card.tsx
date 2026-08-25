/**
 * Quick-commands settings card (设置 → 插件配置): an expandable plugin card —
 * header (title + description + chevron) collapsed by default, body reveals
 * the workspace × command-set editor and the popup anchor preference. Body
 * edits instant-save per change; partial rows (empty name/command) persist
 * while the user types.
 *
 * Mirrors the official PluginCard disclosure pattern (header button with
 * aria-expanded, rotate-180 chevron, body separated by a top border).
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconPlusOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { quickApi } from './api'
import type { QuickRosterEntry, QuickCommandsSettings } from '../shared/contract'

interface Props {
  t: (key: string) => string
}

interface RosterState {
  loaded: boolean
  entries: QuickRosterEntry[]
  anchor: QuickCommandsSettings['popupAnchor']
}

type CommandDraft = { name: string; command: string }

export function QuickCommandsSettingsCard({ t }: Props): JSX.Element {
  // Card-local disclosure state (a reading gesture, like the official card).
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<RosterState>({ loaded: false, entries: [], anchor: 'corner' })
  const [error, setError] = useState<string | null>(null)
  // Guard concurrent saves: the last write wins via a monotonically bumped token.
  const saveToken = useRef(0)

  const load = async (): Promise<void> => {
    try {
      const [entries, settings] = await Promise.all([quickApi.workspacesList(), quickApi.settingsGet()])
      setState({ loaded: true, entries, anchor: settings.popupAnchor })
      setError(null)
    } catch (e) {
      setState((s) => ({ ...s, loaded: true }))
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /** Instant-save the workspace's whole command set; optimistic UI. */
  const saveCommands = async (workspaceId: string, commands: CommandDraft[]): Promise<void> => {
    const token = ++saveToken.current
    try {
      const next = await quickApi.settingsSetCommands(workspaceId, commands)
      if (token !== saveToken.current) return
      setState((s) => ({
        ...s,
        anchor: next.popupAnchor,
        entries: s.entries.map((e) => (e.workspaceId === workspaceId ? { ...e, commands } : e)),
      }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Re-sync to server truth on failure.
      void load()
    }
  }

  /** Compute the next command list for a workspace, THEN save + update state. */
  const mutateCommands = (workspaceId: string, next: (current: CommandDraft[]) => CommandDraft[]): void => {
    const entry = state.entries.find((e) => e.workspaceId === workspaceId)
    if (entry === undefined) return
    const commands = next(entry.commands)
    // Optimistic update first (row stays visible immediately), then persist.
    setState((s) => ({
      ...s,
      entries: s.entries.map((e) => (e.workspaceId === workspaceId ? { ...e, commands } : e)),
    }))
    void saveCommands(workspaceId, commands)
  }

  const patchEntry = (workspaceId: string, index: number, field: 'name' | 'command', value: string): void => {
    mutateCommands(workspaceId, (current) =>
      current.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    )
  }

  const addCommand = (workspaceId: string): void => {
    mutateCommands(workspaceId, (current) => [...current, { name: '', command: '' }])
  }

  const removeCommand = (workspaceId: string, index: number): void => {
    mutateCommands(workspaceId, (current) => current.filter((_, i) => i !== index))
  }

  const setAnchor = async (anchor: QuickCommandsSettings['popupAnchor']): Promise<void> => {
    setState((s) => ({ ...s, anchor }))
    try {
      const next = await quickApi.settingsSetAnchor(anchor)
      setState((s) => ({ ...s, anchor: next.popupAnchor }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      void load()
    }
  }

  const title = t('cardTitle')
  const description = t('cardDescription')

  return (
    <li className={'qc-settings-card' + (open ? ' qc-settings-card-open' : '')}>
      <button
        type="button"
        className="qc-settings-header"
        aria-expanded={open}
        aria-label={`${t('collapseOrExpand')}: ${title}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="qc-settings-head-text">
          <span className="qc-settings-name">{title}</span>
          <span className="qc-settings-description">{description}</span>
        </span>
        <IconChevronDownOutline14 className={'qc-settings-chevron' + (open ? ' qc-settings-chevron-open' : '')} />
      </button>

      {open && (
        <div className="qc-settings-body">
          <p className="qc-settings-intro">{t('cardIntro')}</p>

          <div className="qc-settings-anchor">
            <span className="qc-settings-anchor-label">{t('cardAnchor')}</span>
            <label className="qc-settings-radio">
              <input
                type="radio"
                name="qc-anchor"
                checked={state.anchor === 'corner'}
                onChange={() => void setAnchor('corner')}
              />
              {t('cardAnchorCorner')}
            </label>
            <label className="qc-settings-radio">
              <input
                type="radio"
                name="qc-anchor"
                checked={state.anchor === 'button'}
                onChange={() => void setAnchor('button')}
              />
              {t('cardAnchorButton')}
            </label>
          </div>

          {error !== null && <div className="qc-settings-error">{t('cardSaveError')}: {error}</div>}

          {state.loaded && state.entries.length === 0 && (
            <p className="qc-settings-empty">{t('cardNoWorkspaces')}</p>
          )}

          {state.entries.map((entry) => (
            <section key={entry.workspaceId} className="qc-settings-workspace">
              <header className="qc-settings-workspace-head">
                <span className="qc-settings-workspace-title">{entry.title || entry.path || entry.workspaceId}</span>
                <span className="qc-settings-workspace-path">{entry.path}</span>
              </header>
              {entry.commands.length === 0 && (
                <p className="qc-settings-no-commands">{t('cardNoCommands')}</p>
              )}
              {entry.commands.map((command, index) => (
                <div key={`${entry.workspaceId}-${index}`} className="qc-settings-command">
                  <input
                    className="qc-settings-field qc-settings-field-name"
                    placeholder={t('cardName')}
                    value={command.name}
                    aria-label={t('cardName')}
                    onChange={(e) => patchEntry(entry.workspaceId, index, 'name', e.target.value)}
                  />
                  <input
                    className="qc-settings-field qc-settings-field-command"
                    placeholder={t('cardCommand')}
                    value={command.command}
                    aria-label={t('cardCommand')}
                    onChange={(e) => patchEntry(entry.workspaceId, index, 'command', e.target.value)}
                  />
                  <button
                    type="button"
                    className="qc-settings-icon-btn"
                    aria-label={t('cardRemove')}
                    title={t('cardRemove')}
                    onClick={() => removeCommand(entry.workspaceId, index)}
                  >
                    <IconTrashOutline16 size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className="qc-settings-add-btn" onClick={() => addCommand(entry.workspaceId)}>
                <IconPlusOutline16 size={14} />
                {t('cardAddCommand')}
              </button>
            </section>
          ))}
        </div>
      )}
    </li>
  )
}
