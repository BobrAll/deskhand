/**
 * One permission, as a row with a request button and a way to the system pane.
 *
 * Moved here unchanged from `App.tsx` (R17): the props are the same, the markup is
 * the same, the words are the same. What is left in `App.tsx` is the wiring.
 */

export interface PermissionRowProps {
  title: string
  description: string
  granted: boolean
  onRequest(): Promise<void>
  onOpen(): void
}

export function PermissionRow(props: PermissionRowProps) {
  return (
    <div className="permission">
      <div>
        <div className="permission-title">
          {props.title}{' '}
          {props.granted ? <span className="ok">✓</span> : <span className="warn">—</span>}
        </div>
        <div className="hint">{props.description}</div>
      </div>
      <div className="permission-actions">
        {!props.granted && (
          <button className="primary" onClick={() => void props.onRequest()}>
            Запросить
          </button>
        )}
        <button onClick={props.onOpen}>Системные настройки</button>
      </div>
    </div>
  )
}
