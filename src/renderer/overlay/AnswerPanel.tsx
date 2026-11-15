import type { Ref, UIEventHandler } from 'react'
import type { RefineDirection } from '@shared/types'
import { REFINE_HINT, REFINE_LABEL } from './copy'
import { Markdown } from './markdownText'

interface Props {
  answer: string
  hasAnswer: boolean
  busy: boolean
  answerReady: boolean
  expanded: boolean
  newText: boolean
  answerRef: Ref<HTMLDivElement>
  onAnswerScroll: UIEventHandler<HTMLDivElement>
  jumpToNewText(): void
  speaking: boolean
  speechError: string | null
  toggleSpeech(): void
  userWidth: number | null
  wanted: number | null
  toggleWidth(): void
  copied: boolean
  copy(): Promise<void>
  refine(direction: RefineDirection): void
}

export function AnswerPanel({
  answer,
  hasAnswer,
  busy,
  answerReady,
  expanded,
  newText,
  answerRef,
  onAnswerScroll,
  jumpToNewText,
  speaking,
  speechError,
  toggleSpeech,
  userWidth,
  wanted,
  toggleWidth,
  copied,
  copy,
  refine
}: Props) {
  return (
    <>
      {/*
        Only real text earns an answer row. An empty "thinking" box under the
        field is what made a voice action look like it had answered something.
      */}
      {hasAnswer && (
        <div className="answer-wrap">
          <div ref={answerRef} className="answer" onScroll={onAnswerScroll}>
            <Markdown text={answer} streaming={busy} caret={busy} />
          </div>
          {newText && (
            <button className="new-text" onClick={jumpToNewText}>
              ↓ Новый текст
            </button>
          )}
        </div>
      )}

      {/* The everyday actions, on one row; rewrites live in the drawer. */}
      {hasAnswer && (!busy || speaking) && (
        <div className="foot answer-actions">
          <button className="link" onClick={toggleSpeech}>
            {speaking ? 'Остановить озвучку' : 'Прослушать'}
          </button>
          {answerReady && (
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
              {userWidth !== null && (
                <button className="link" title="Вернуть ширину по содержимому" onClick={toggleWidth}>
                  Вернуть
                </button>
              )}
              {userWidth === null && wanted !== null && (
                <button className="link" title="Развернуть по содержимому" onClick={toggleWidth}>
                  Шире
                </button>
              )}
              <button
                className="link"
                data-copied={copied || undefined}
                title={copied ? 'Скопировано в буфер обмена' : 'Скопировать ответ'}
                onClick={() => void copy()}
              >
                {copied ? '✓ Скопировано' : 'Скопировать'}
              </button>
            </>
          )}
        </div>
      )}
      {speechError && (
        <div className="line" role="status">
          {speechError}
        </div>
      )}

      {hasAnswer && expanded && (
        <div className="foot">
          {!busy && (
            <>
              {(Object.keys(REFINE_LABEL) as RefineDirection[]).map((direction) => (
                <button
                  key={direction}
                  className="link"
                  title={REFINE_HINT[direction]}
                  onClick={() => refine(direction)}
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
