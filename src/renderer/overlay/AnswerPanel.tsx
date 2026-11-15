import type { Ref, UIEventHandler } from 'react'
import type { RefineDirection } from '@shared/types'
import { REFINE_HINT, REFINE_LABEL } from './copy'
import { Markdown } from './markdownText'

interface AnswerView {
  text: string
  hasAnswer: boolean
  busy: boolean
  ready: boolean
  expanded: boolean
  newText: boolean
  ref: Ref<HTMLDivElement>
  onScroll: UIEventHandler<HTMLDivElement>
  jumpToNewText(): void
}

interface AnswerActions {
  copied: boolean
  copy(): Promise<void>
  refine(direction: RefineDirection): void
}

interface AnswerSpeech {
  speaking: boolean
  error: string | null
  toggle(): void
}

interface AnswerWidth {
  user: number | null
  wanted: number | null
  toggle(): void
}

interface Props {
  answer: AnswerView
  actions: AnswerActions
  speech: AnswerSpeech
  width: AnswerWidth
}

export function AnswerPanel({ answer, actions, speech, width }: Props) {
  return (
    <>
      {/*
        Only real text earns an answer row. An empty "thinking" box under the
        field is what made a voice action look like it had answered something.
      */}
      {answer.hasAnswer && (
        <div className="answer-wrap">
          <div ref={answer.ref} className="answer" onScroll={answer.onScroll}>
            <Markdown text={answer.text} streaming={answer.busy} caret={answer.busy} />
          </div>
          {answer.newText && (
            <button className="new-text" onClick={answer.jumpToNewText}>
              ↓ Новый текст
            </button>
          )}
        </div>
      )}

      {/* The everyday actions, on one row; rewrites live in the drawer. */}
      {answer.hasAnswer && (!answer.busy || speech.speaking) && (
        <div className="foot answer-actions">
          <button className="link" onClick={speech.toggle}>
            {speech.speaking ? 'Остановить озвучку' : 'Прослушать'}
          </button>
          {answer.ready && (
            <>
              <span className="spacer" />
              {/*
                The one-click half of the drag. It is in the action row rather
                than behind the chevron because the moment you notice a table is
                cramped is the moment you are looking at it.

                Only shown when the content is actually wider than the card: a
                «Шире» that widens a two-word answer is a button that does
                nothing, and a person who presses it once and sees no change
                stops trusting the edge.
              */}
              {width.user !== null && (
                <button className="link" title="Вернуть ширину по содержимому" onClick={width.toggle}>
                  Вернуть
                </button>
              )}
              {width.user === null && width.wanted !== null && (
                <button className="link" title="Развернуть по содержимому" onClick={width.toggle}>
                  Шире
                </button>
              )}
              <button
                className="link"
                data-copied={actions.copied || undefined}
                title={actions.copied ? 'Скопировано в буфер обмена' : 'Скопировать ответ'}
                onClick={() => void actions.copy()}
              >
                {actions.copied ? '✓ Скопировано' : 'Скопировать'}
              </button>
            </>
          )}
        </div>
      )}
      {speech.error && (
        <div className="line" role="status">
          {speech.error}
        </div>
      )}

      {answer.hasAnswer && answer.expanded && (
        <div className="foot">
          {!answer.busy && (
            <>
              {(Object.keys(REFINE_LABEL) as RefineDirection[]).map((direction) => (
                <button
                  key={direction}
                  className="link"
                  title={REFINE_HINT[direction]}
                  onClick={() => actions.refine(direction)}
                >
                  {REFINE_LABEL[direction]}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </>
  )
}
