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
    <Row title={props.title} hint={props.hint} stacked={!props.granted}>
      <div className="row-actions">
        <span className={props.granted ? 'permission-state ok' : 'permission-state warn'}>
          {props.granted ? '● Разрешено' : '● Не разрешено'}
        </span>
        {!props.granted && (
          <button className="primary" onClick={() => void props.onRequest()}>
            Запросить
          </button>
        )}
        <button
          className="ghost"
          aria-label={props.granted ? `Отозвать в macOS · ${props.title}` : `Системные настройки · ${props.title}`}
          onClick={props.onOpen}
        >
          {props.granted ? 'Отозвать в macOS' : 'Системные настройки'}
        </button>
      </div>
    </Row>
  )
}
