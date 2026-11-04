/**
 * The «Поведение» tab: hotkey, the two checkboxes, screenshot size and quality.
 *
 * Moved out of `App.tsx` verbatim. `hotkeyError` is a prop rather than local
 * state because the message is set by the write path in the window (`flush`),
 * not by anything the user does on this tab.
 */

import type { AppSettings } from '@shared/types'
import { HotkeyField } from '../HotkeyField'

interface BehaviorSectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
  hotkeyError: string | null
  /** Clearing it belongs to the field: typing a new combination retracts the error. */
  onHotkeyError(value: string | null): void
}

export function BehaviorSection({
  draft,
  patch,
  hotkeyError,
  onHotkeyError
}: BehaviorSectionProps) {
  return (
    <section>
      <h2>Поведение</h2>

      <div className="field">
        <label>Глобальная горячая клавиша</label>
        <HotkeyField
          value={draft.hotkey}
          onChange={(accelerator) => {
            onHotkeyError(null)
            patch({ hotkey: accelerator })
          }}
        />
        {hotkeyError && <div className="hint err">{hotkeyError}</div>}
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.captureScreenshotByDefault}
          onChange={(event) => patch({ captureScreenshotByDefault: event.target.checked })}
        />
        Делать скриншот, когда нет выделения — по нему ассистент сам решает,
        что обвести и куда показать стрелкой
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.launchAtLogin}
          onChange={(event) => patch({ launchAtLogin: event.target.checked })}
        />
        Запускать при входе в систему
      </label>

      <div className="row-grid">
        <div className="field">
          <label>Длинная сторона скриншота · {draft.screenshotMaxSide}px</label>
          <input
            type="range"
            min={480}
            max={2400}
            step={80}
            value={draft.screenshotMaxSide}
            onChange={(event) => patch({ screenshotMaxSide: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label>Качество JPEG · {draft.screenshotQuality}</label>
          <input
            type="range"
            min={30}
            max={95}
            step={5}
            value={draft.screenshotQuality}
            onChange={(event) => patch({ screenshotQuality: Number(event.target.value) })}
          />
        </div>
      </div>

      <div className="hint">
        Меньше длинная сторона и качество — быстрее ответ и меньше расход токенов.
      </div>
    </section>
  )
}
