/**
 * The three shapes a settings pane is made of: a group, a row, a switch.
 *
 * The window used to be a column of `.field` blocks, each one a label above a
 * control above a paragraph. That reads like a form: every item competes for the
 * same weight, the eye has nowhere to land, and a hint three lines long pushed
 * the next control out of view. A pane built from these instead reads like a
 * list of settings — the name of the thing on the left, the thing itself on the
 * right, the explanation underneath in a smaller grey, and a card around a
 * handful of rows that belong together.
 *
 * `Row` has two layouts. Side by side is the default, for controls that are
 * small enough to sit next to their label — a switch, a key cap, a number. When
 * the control needs the width (a text field, a list, a segmented picker) the row
 * stacks, because squeezing a URL field into the right third of a card is how
 * "topорно" happens.
 */

import { type ReactNode } from 'react'

interface GroupProps {
  title?: string
  /** A sentence under the card, for something that applies to all of its rows. */
  footnote?: string
  children: ReactNode
}

export function Group({ title, footnote, children }: GroupProps) {
  return (
    <section className="group">
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group-body">{children}</div>
      {footnote && <p className="group-foot">{footnote}</p>}
    </section>
  )
}

interface RowProps {
  title?: ReactNode
  hint?: ReactNode
  /** Stack the control under the title instead of beside it. */
  stacked?: boolean
  /** Replace the title/hint block entirely (for a row that is just a control). */
  children?: ReactNode
}

export function Row({ title, hint, stacked, children }: RowProps) {
  return (
    <div className={stacked ? 'row row-stacked' : 'row'}>
      {(title || hint) && (
        <div className="row-main">
          {title && <div className="row-title">{title}</div>}
          {hint && <div className="row-hint">{hint}</div>}
        </div>
      )}
      {children &&
        (stacked ? <div className="row-body">{children}</div> : <div className="row-control">{children}</div>)}
    </div>
  )
}

interface ToggleRowProps {
  title: ReactNode
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
}

/**
 * A setting that is on or off.
 *
 * A switch rather than a checkbox: a checkbox at the end of a sentence reads as
 * part of the sentence, and in this window several of them decide whether the
 * assistant may touch the machine at all. The switch says "this is a state" and
 * the whole row is the hit target, which is also the reason `aria-checked` sits
 * on a `button` instead of a `label` wrapping an input.
 */
export function ToggleRow({ title, hint, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof title === 'string' ? title : undefined}
      disabled={disabled}
      className="row row-toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="row-main">
        <span className="row-title">{title}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </span>
      {/* The switch is a picture, not a second control: a button inside a button
          is invalid, and a click anywhere on the row already means the same. */}
      <span className="switch" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  )
}

interface ToggleProps {
  checked: boolean
  /** Required when there is no visible text next to it to name it. */
  label?: string
  disabled?: boolean
  onChange(checked: boolean): void
}

/** The switch on its own, for places that already have their own label. */
export function Toggle({ checked, label, disabled, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

interface DisclosureProps {
  title: string
  /** A marker on the summary, e.g. a warning while a field inside is invalid. */
  badge?: ReactNode
  /**
   * Controlled open state. Omit both this and `onToggle` to keep the native
   * behaviour; pass both when the window must reveal the card on its own.
   */
  open?: boolean
  onToggle?(open: boolean): void
  children: ReactNode
}

/** A card whose rows are hidden until asked for: the settings almost nobody changes. */
export function Disclosure({ title, badge, open, onToggle, children }: DisclosureProps) {
  return (
    <details className="disclosure" open={open} onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary>
        {badge ? (
          <>
            <span className="disclosure-title">{title}</span>
            {badge}
          </>
        ) : (
          title
        )}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
