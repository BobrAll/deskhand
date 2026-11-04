/**
 * The quick actions list: label, mode, prompt, and a remove button per row.
 *
 * Moved here unchanged from `App.tsx` (R17). The one thing worth keeping in mind
 * is that an empty row is a legitimate intermediate state — the user has just
 * pressed «+ Добавить действие» and has not typed anything yet — which is why
 * `applyGate.ts` drops empty rows on the way to disk instead of refusing the
 * whole write.
 */

import type { QuickAction } from '@shared/types'

export interface QuickActionsEditorProps {
  actions: QuickAction[]
  onChange(actions: QuickAction[]): void
}

export function QuickActionsEditor(props: QuickActionsEditorProps) {
  const update = (index: number, changes: Partial<QuickAction>): void => {
    props.onChange(
      props.actions.map((action, i) => (i === index ? { ...action, ...changes } : action))
    )
  }

  return (
    <div className="quick-actions">
      {props.actions.map((action, index) => (
        <div key={action.id} className="quick-action">
          <input
            className="qa-label"
            value={action.label}
            placeholder="Название"
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <select
            className="qa-mode"
            value={action.mode}
            onChange={(event) =>
              update(index, { mode: event.target.value === 'analyze' ? 'analyze' : 'insert' })
            }
          >
            <option value="insert">вставка</option>
            <option value="analyze">анализ</option>
          </select>
          <textarea
            className="qa-prompt"
            rows={2}
            value={action.prompt}
            placeholder="Промпт"
            onChange={(event) => update(index, { prompt: event.target.value })}
          />
          <button
            className="ghost"
            title="Удалить"
            onClick={() => props.onChange(props.actions.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          props.onChange([
            ...props.actions,
            {
              id: `custom-${Date.now().toString(36)}`,
              label: 'Новое действие',
              prompt: '',
              mode: 'insert'
            }
          ])
        }
      >
        + Добавить действие
      </button>
    </div>
  )
}
