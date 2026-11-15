import type { ContextFlags, ContextSnapshot } from '@shared/types'
import { LiveThumb } from './LiveThumb'

interface Props {
  context: ContextSnapshot
  flags: ContextFlags
  drawn: number
  toggleFlag(key: 'includeSelection' | 'includeScreenshot'): void
  clearDrawing(): void
}

export function ContextDrawer({ context, flags, drawn, toggleFlag, clearDrawing }: Props) {
  const { selection, screenshot } = context
  return (
    <div className="drawer">
      <div className="meta">
        <span className="app" title={context.activeApp?.bundleId ?? ''}>
          {context.activeApp?.name ?? 'Без приложения'}
        </span>
        <button
          className="tag"
          data-on={flags.includeSelection && Boolean(selection)}
          disabled={!selection}
          onClick={() => toggleFlag('includeSelection')}
          title={
            selection ? `Использовать выделенный текст: ${selection.text.slice(0, 200)}` : 'Выделенный текст не найден'
          }
        >
          {selection ? `Текст · ${selection.text.length}` : 'Текст'}
        </button>
        <button
          className="tag"
          data-on={flags.includeScreenshot && Boolean(screenshot)}
          disabled={!screenshot}
          onClick={() => toggleFlag('includeScreenshot')}
          title={
            screenshot
              ? 'Ассистент видит экран — и сам решит, когда обвести элемент или показать стрелкой'
              : 'Скриншот недоступен'
          }
        >
          {context.screenshotPending ? 'Экран…' : 'Экран'}
        </button>
        {screenshot && flags.includeScreenshot && <LiveThumb src={screenshot.dataUrl} />}
        {drawn > 0 && (
          <button className="tag clear" onClick={clearDrawing} title="Убрать рисунок с экрана">
            Рисунок {drawn} ×
          </button>
        )}
      </div>
    </div>
  )
}
