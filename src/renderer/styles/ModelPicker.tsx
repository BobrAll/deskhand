import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

interface ModelPickerProps {
  models: string[]
  selected: string
  query: string
  disabled?: boolean
  searchLabel: string
  searchPlaceholder: string
  listLabel: string
  searchInputRef?: RefObject<HTMLInputElement>
  onQuery(value: string): void
  onSelect(value: string): void
}

/**
 * What Enter should use: an exact catalogue entry, or the text typed by hand.
 *
 * The filter is case-insensitive, so `GPT-4.1` finds `gpt-4.1` and the catalogue
 * spelling wins. Anything else is a manual ID the user chose to type.
 */
export function resolveModelInput(query: string, models: readonly string[]): string | null {
  const value = query.trim()
  if (!value) return null
  return models.find((id) => id.toLowerCase() === value.toLowerCase()) ?? value
}

/**
 * One field for finding a model and for entering an ID the catalogue lacks.
 *
 * Typing filters the list. Clicking a row selects it; Enter selects the exact
 * match or, when there is none, the typed text as a manual ID. Once a model is
 * chosen the list closes into one row with the current ID, because an open list
 * under a completed choice reads like the choice is still missing.
 */
export function ModelPicker({
  models,
  selected,
  query,
  disabled = false,
  searchLabel,
  searchPlaceholder,
  listLabel,
  searchInputRef,
  onQuery,
  onSelect
}: ModelPickerProps) {
  const id = useId()
  const listId = `${id}-list`
  const noteId = `${id}-note`
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const focusSearch = useRef(false)
  const focusSelected = useRef(false)
  const mounted = useRef(false)
  const [editing, setEditing] = useState(false)
  const open = !selected || editing
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? models.filter((id) => id.toLowerCase().includes(normalized)) : models
  }, [models, query])
  const resolved = resolveModelInput(query, models)
  const custom = resolved && resolved !== selected && !models.includes(resolved) ? resolved : null
  const missingFromCatalog =
    Boolean(selected) && models.length > 0 && !models.some((model) => model.toLowerCase() === selected.toLowerCase())

  useEffect(() => {
    const initial = !mounted.current
    mounted.current = true
    if (open && (initial || focusSearch.current)) {
      focusSearch.current = false
      searchInputRef?.current?.focus()
    } else if (!open && (initial || focusSelected.current)) {
      focusSelected.current = false
      selectedRef.current?.focus()
    }
  }, [open, searchInputRef])

  function startEditing(): void {
    focusSearch.current = true
    onQuery('')
    setEditing(true)
  }

  function cancelEditing(): void {
    onQuery('')
    focusSelected.current = true
    setEditing(false)
  }

  function choose(id: string): void {
    onSelect(id)
    onQuery('')
    focusSelected.current = true
    setEditing(false)
  }

  function reset(): void {
    onSelect('')
    onQuery('')
    // An empty choice keeps the picker open; the field is where the next action
    // starts, and the reset button itself is gone by then.
    searchInputRef?.current?.focus()
  }

  /**
   * Escape works from anywhere in the picker, not only from the input: after an
   * Arrow key the focus is on a row, and that is exactly where a user expects to
   * back out.
   */
  function handleEscape(event: KeyboardEvent<HTMLDivElement>): void {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    if (query) {
      onQuery('')
      searchInputRef?.current?.focus()
    } else if (selected) {
      cancelEditing()
    }
  }

  /**
   * Arrow keys move through a list that can be hundreds of rows long.
   *
   * Every option is a real button, so Enter and Space already select it; this only
   * adds the movement that a native select had and a plain column of buttons does
   * not.
   */
  function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.model-option'))
    if (options.length === 0) return
    event.preventDefault()
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const last = options.length - 1
    if (event.key === 'Home') options[0].focus()
    else if (event.key === 'End') options[last].focus()
    else if (event.key === 'ArrowDown') options[current < 0 ? 0 : Math.min(current + 1, last)].focus()
    else options[current < 0 ? last : Math.max(current - 1, 0)].focus()
  }

  const focusable = selected && visible.includes(selected) ? selected : visible[0]

  return (
    <div className="model-picker" onKeyDown={handleEscape}>
      {open ? (
        <>
          <div className="model-picker-search">
            <input
              ref={searchInputRef}
              value={query}
              disabled={disabled}
              onChange={(event) => onQuery(event.target.value)}
              role="combobox"
              aria-expanded={true}
              aria-controls={visible.length > 0 ? listId : undefined}
              aria-autocomplete="list"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (resolved) choose(resolved)
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const selectedOption = listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
                  const firstOption = listRef.current?.querySelector<HTMLButtonElement>('.model-option')
                  ;(selectedOption ?? firstOption)?.focus()
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={searchLabel}
              spellCheck={false}
            />
            {query && !disabled && (
              <button
                type="button"
                className="model-picker-clear"
                aria-label="Очистить поиск"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onQuery('')
                  searchInputRef?.current?.focus()
                }}
              >
                ×
              </button>
            )}
            <span className="model-picker-count">
              {visible.length} из {models.length}
            </span>
            {selected && !disabled && (
              <button type="button" className="model-picker-cancel" onClick={cancelEditing}>
                Отмена
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <div className="model-list-empty" role="status">
              Совпадений в списке нет.
            </div>
          ) : (
            <div
              ref={listRef}
              className="model-list"
              id={listId}
              role="listbox"
              aria-label={listLabel}
              onKeyDown={moveFocus}
            >
              {visible.map((id) => {
                const active = id === selected
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="model-option"
                    disabled={disabled}
                    tabIndex={id === focusable ? 0 : -1}
                    onClick={() => choose(id)}
                  >
                    <span className="model-option-id">{id}</span>
                    {active && (
                      <span className="model-option-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {custom && (
            <button type="button" className="model-custom" disabled={disabled} onClick={() => choose(custom)}>
              Использовать «{custom}» как ID модели
            </button>
          )}
          {selected && (
            <button type="button" className="model-reset" disabled={disabled} onClick={reset}>
              Сбросить модель
            </button>
          )}
        </>
      ) : (
        <>
          <button
            ref={selectedRef}
            type="button"
            className="model-picker-selected"
            disabled={disabled}
            aria-label={`Модель ${selected} выбрана. Сменить`}
            aria-describedby={missingFromCatalog ? noteId : undefined}
            onClick={startEditing}
          >
            <span className="model-picker-check" aria-hidden="true">
              ✓
            </span>
            <span className="model-picker-selected-id">{selected}</span>
            <span className="model-picker-change">Сменить</span>
          </button>
          {missingFromCatalog && (
            <div className="model-picker-note" id={noteId} role="status">
              В загруженном списке её нет — проверь ID.
            </div>
          )}
        </>
      )}
    </div>
  )
}
