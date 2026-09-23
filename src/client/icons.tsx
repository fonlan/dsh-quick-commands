/**
 * Icon compatibility layer over `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * DSH renamed this package's icon exports in 0.1.7: the size-suffixed names
 * (`IconPlayOutline16`) became weight-suffixed ones (`IconPlayOutlineRegular` /
 * `IconPlayOutlineMedium`, matching what the official header plugins use).
 *
 * A client bundle that statically imports a name the host no longer exports
 * receives `undefined`; rendering that element throws, the slot's per-entry
 * error boundary swallows the whole entry, and the surface silently vanishes —
 * exactly how the header ▶ button disappeared on 0.1.7.
 *
 * Resolving by name at runtime (new scheme → legacy scheme → bundled artwork)
 * keeps every surface rendering across DSH alphas. The bundled artwork is only
 * a last resort, so a future rename can never blank a control again.
 */
import type { ReactElement, ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** Props both naming schemes accept (the legacy exports ignore extra fields). */
export interface IconProps {
  /** Rendered square size in CSS pixels. */
  size?: number
  className?: string
}

type IconComponent = (props: IconProps) => ReactElement

const ICON_EXPORTS = primitives as unknown as Record<string, IconComponent | undefined>

/** First export name that exists on the running host, else the bundled artwork. */
function pickIcon(exportNames: readonly string[], fallback: IconComponent): IconComponent {
  for (const name of exportNames) {
    const candidate = ICON_EXPORTS[name]
    if (typeof candidate === 'function') return candidate
  }
  return fallback
}

/** Wrap one locally drawn 16×16 artwork as an icon component. */
function localIcon(children: ReactNode): IconComponent {
  return function LocalIcon({ size = 16, className }: IconProps): ReactElement {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        {children}
      </svg>
    )
  }
}

/** Run/play glyph for the header quick-run button. */
export const PlayIcon = pickIcon(
  ['IconPlayOutlineRegular', 'IconPlayOutlineMedium', 'IconPlayOutline16'],
  localIcon(
    <>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
      <path d="M6.6 5.9 10.4 8l-3.8 2.1Z" fill="currentColor" />
    </>,
  ),
)

/** Dismiss glyph (menu header and popup close). */
export const CloseIcon = pickIcon(
  ['IconCloseOutlineRegular', 'IconCloseOutlineMedium', 'IconCloseOutline16'],
  localIcon(
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  ),
)

/** Stop/kill glyph for a running command. */
export const StopIcon = pickIcon(
  ['IconStopFillRegular', 'IconStopFillMedium', 'IconStopFill16'],
  localIcon(<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.6" fill="currentColor" />),
)

/** Add-row glyph in the settings page. */
export const PlusIcon = pickIcon(
  ['IconPlusOutlineRegular', 'IconPlusOutlineMedium', 'IconPlusOutline16'],
  localIcon(
    <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  ),
)

/** Remove-command glyph in the settings page. */
export const TrashIcon = pickIcon(
  ['IconTrashOutlineRegular', 'IconTrashOutlineMedium', 'IconTrashOutline16'],
  localIcon(
    <>
      <path d="M3.4 4.4h9.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M6.4 4.4V3.1h3.2v1.3M4.9 4.4l.6 8.5h5l.6-8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>,
  ),
)
