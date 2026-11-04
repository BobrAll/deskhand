/**
 * The «Быстрые действия» tab: the wrapper around `QuickActionsEditor`.
 *
 * Moved out of `App.tsx` verbatim, heading and hint included — the heading is
 * the only reason this is a component rather than the editor used directly.
 */

import type { AppSettings } from '@shared/types'
import { QuickActionsEditor } from '../QuickActionsEditor'

interface ActionsSectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
}

export function ActionsSection({ draft, patch }: ActionsSectionProps) {
  return (
    <section>
      <h2>Быстрые действия</h2>
      <p className="hint">Порядок кнопок в оверлее. Пустые поля игнорируются.</p>
      <QuickActionsEditor
        actions={draft.quickActions}
        onChange={(quickActions) => patch({ quickActions })}
      />
    </section>
  )
}
