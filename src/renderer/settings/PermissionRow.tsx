/**
 * One permission, as a row: what it is, whether it is granted, and the two ways
 * to get it.
 *
 * The state is a word, not a tick: "Разрешено" / "Не разрешено" survives a
 * colour-blind glance and a screenshot in a bug report, where a green check and
 * an amber dash are two blobs of similar shape.
 */

import { Row } from './Row'

export interface PermissionRowProps {
  title: string
  hint: string
  granted: boolean
  onRequest(): Promise<void>
  onOpen(): void
}

export function PermissionRow(props: PermissionRowProps) {
  return (
    <Row
      title={props.title}
      hint={props.hint}
      stacked={!props.granted}
    >
      <div className="row-actions">
        <span className={props.granted ? 'permission-state ok' : 'permission-state warn'}>
          {props.granted ? '● Разрешено' : '● Не разрешено'}
        </span>
        {!props.granted && (
          <button className="primary" onClick={() => void props.onRequest()}>
            Запросить
          </button>
        )}
        <button className="ghost" onClick={props.onOpen}>
          Системные настройки
        </button>
      </div>
    </Row>
  )
}
