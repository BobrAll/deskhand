/**
 * The overlay UI (ТЗ §8).
 *
 * A card, not a window: one line for the question, the answer printed directly
 * underneath it. It appears next to the cursor (the main process owns the
 * placement) as *only* that line plus one small chevron; context tags and the answer's secondary commands stay folded behind the chevron, so
 * the common case — ask, read, copy — is a small rectangle that never covers the
 * screen.
 *
 * Keyboard: Enter sends, Esc closes, Cmd/Ctrl+C copies the answer when nothing
 * is selected.
 *
 * Width is the one thing the card lets a person overrule. It sizes itself to its
 * content up to `CARD_WIDTH`, which is right for a sentence and wrong for a table;
 * the right edge can be dragged, and «Шире» does the same thing in one click. The
 * decision itself lives in `cardWidth.ts`.
 */

import type { CSSProperties } from 'react'
import { CARD_MIN_WIDTH, CARD_WIDTH } from '@shared/metrics'
import { looksLikeAction } from '@shared/intent'
import { useCardGeometry } from './useCardGeometry'
import { AGENT_ENABLED_NOTICE, useOverlayController } from './useOverlayController'
import { deriveView } from './viewFlags'
import { agentLabel, agentMark } from './agentRow'
import { AgentStatus } from './AgentStatus'
import { AnswerPanel } from './AnswerPanel'
import { ContextDrawer } from './ContextDrawer'
import { userWidthCeiling } from './cardWidth'

/** The bars on the voice surface. */
const VOICE_BARS = 5
/** The bars' resting height and how much of the microphone level they add. */
const VOICE_AMP_BASE = 0.62
const VOICE_AMP_PER_LEVEL = 0.55

export function App() {
  const {
    speech,
    state,
    prompt,
    setPrompt,
    answer,
    answerRef,
    newText,
    onAnswerScroll,
    jumpToNewText,
    busy,
    failure,
    notice,
    copied,
    drawn,
    typing,
    setTyping,
    typingRef,
    dragAnywhere,
    userWidth,
    setUserWidth,
    expanded,
    setExpanded,
    agent,
    last,
    inputRef,
    voice,
    listening,
    hasAnswer,
    waiting,
    waitStage,
    onPromptKeyDown,
    retryLast,
    toggleFlag,
    clearDrawing,
    setAgentEnabled,
    answerAgent,
    copy,
    closeCard,
    cancelRequest,
    refine
  } = useOverlayController()

  /** The bars open with the voice; the meter arrives at ~10 Hz, hence the transition. */
  const amp = voice.phase === 'listening' ? VOICE_AMP_BASE + voice.level * VOICE_AMP_PER_LEVEL : 1

  const agentRunning = busy && agent !== null
  const agentStatus = agent && agentLabel(agent, answer)
  const agentHint = agentRunning && agent?.phase !== 'asking' ? 'Esc — остановить' : null
  const agentDone = !busy && !hasAnswer && agent !== null && agentMark(agent) === 'done'
  const showWaiting = waitStage !== 'quiet' && !hasAnswer && !agent
  /** An action that produced an answer because the agent is blocked, not refused. */
  const blockedAction = Boolean(
    state &&
    state.agent.enabled &&
    !state.agent.ready &&
    !state.context.excluded &&
    hasAnswer &&
    !busy &&
    !agentRunning &&
    last &&
    !last.refine &&
    looksLikeAction(last.prompt)
  )
  const wantsWide =
    (expanded && !agentRunning) || Boolean(failure) || agent?.phase === 'asking' || showWaiting || blockedAction

  const { cardWidth, wrapped, rootRef, fieldRef, wanted, toggleWidth, dragging, gripDown, gripMove, gripUp, gripKey } =
    useCardGeometry({
      prompt,
      answer,
      hasAnswer,
      busy,
      speaking: speech.speaking,
      agentStatus,
      agentHint,
      agentRunning,
      listening,
      wantsWide,
      inputRef,
      typingRef,
      userWidth,
      setUserWidth
    })

  // Nothing at all until the renderer knows whether a turn is running — see
  // `ready` in `useVoice`.
  if (!voice.ready) return null

  /**
   * A voice turn is not a card: there is no glass, no field, no padding — just the
   * bars, hanging where the input field would be. This is rendered before the card
   * on purpose. The turn starts while the context is still being collected, and
   * the bars are the only thing that should be on screen then.
   */
  if (listening) {
    return (
      <div
        ref={rootRef}
        className="card"
        style={{ width: cardWidth }}
        data-voice
        data-drag-anywhere={dragAnywhere || undefined}
      >
        <div
          className="voice"
          data-phase={voice.phase}
          style={{ '--amp': amp.toFixed(3) } as CSSProperties}
          role="status"
          aria-label={voice.phase === 'listening' ? 'Слушаю' : 'Распознаю'}
        >
          {Array.from({ length: VOICE_BARS }, (_, bar) => (
            <i key={bar} />
          ))}
        </div>
      </div>
    )
  }

  /**
   * Everything the card decides about itself, in one place and out of this file.
   *
   * The flags are a pure function of the session, the drawer and the last request
   * — see `viewFlags.ts`. They used to be expressions here, which meant they could
   * only be checked by looking at the card. `blocked` is one of them: the field
   * needs it before the session exists, and the drawer's lines need it after.
   */
  const { blocked, showMeta, answerReady, agentOff, agentBlocked, promptLooksLikeAction, hint, needsAttention } =
    deriveView({
      session: state,
      expanded,
      hasAnswer,
      busy,
      failed: Boolean(failure),
      last
    })
  const showingTranscript = busy && last?.spoken && Boolean(prompt)
  /**
   * The field is shared by the provisional and ready card.
   *
   * Held as an expression because the card renders it in two states — while the
   * context is still being collected, and once the session is there with the
   * chevron and the stop button beside it.
   */
  const composer = (
    <textarea
      ref={fieldRef}
      className="prompt"
      rows={1}
      spellCheck
      placeholder="Что сделать?"
      aria-label="Что сделать?"
      data-wrap={wrapped || undefined}
      value={prompt}
      disabled={blocked}
      readOnly={showingTranscript}
      onChange={(event) => {
        setPrompt(event.target.value)
        setTyping(true)
      }}
      onBlur={() => setTyping(false)}
      onKeyDown={onPromptKeyDown}
    />
  )

  /**
   * The card is on screen *before* its session exists.
   *
   * The window comes up on the key press, and the context — frontmost app,
   * selection, screenshot — lands a few hundred milliseconds later. That gap is
   * rendered as the card itself: the same field and the same placeholder.
   * Announcing the wait ("Подготовка контекста…") turned the first beat of every
   * press into a status line nobody asked to read, and made the panel change shape
   * and contents right after it appeared. Collecting the context is background
   * work; the card just looks like itself from frame one.
   */
  if (!state) {
    // Nothing to unfold yet and nothing to send to: the field is the whole card.
    //
    // It is still a real field, and what is typed into it survives the handoff —
    // `reset` keeps the text when the session lands, so a fast typist never loses
    // the beginning of the question to the context collection finishing. Enter
    // before the session exists is a no-op rather than an error: `send` returns
    // without touching the text, and the same Enter works a moment later.
    return (
      <div ref={rootRef} className="card" style={{ width: cardWidth }} data-drag-anywhere={dragAnywhere || undefined}>
        <div className="bar">
          {composer}
          {/*
            The chevron's place, held empty.

            The width the field is measured against already counts a chevron
            (`CHROME_WIDTH`), and the card must not change size when the session
            lands: without a claim on those 22 points the field would take them,
            and the chevron arriving a moment later would push the text 22 points
            to the left — a jump in the middle of the first sentence typed.
          */}
          <span className="reserve" aria-hidden />
          <button className="close" title="Закрыть" aria-label="Закрыть" onClick={closeCard}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  const { context, flags, setupNotice } = state

  return (
    // While the assistant is painting on the screen the card turns into a much
    // thinner sheet of glass: the arrow exists to point at something *behind*
    // the card, and an opaque panel sitting on that very spot is what hides it.
    <div
      ref={rootRef}
      className="card"
      style={{ width: cardWidth }}
      data-busy={busy || undefined}
      data-drawing={(drawn > 0 && !typing) || undefined}
      data-drag-anywhere={dragAnywhere || undefined}
    >
      {!agentRunning && showingTranscript && <div className="line">Распознано</div>}
      {!agentRunning && (
        <div className="bar">
          {composer}
          {busy && (
            <button className="stop" title="Остановить ответ" aria-label="Остановить ответ" onClick={cancelRequest}>
              <span aria-hidden />
            </button>
          )}
          <button
            className="toggle"
            data-open={expanded || undefined}
            data-alert={!expanded && needsAttention ? true : undefined}
            aria-expanded={expanded}
            aria-label={expanded ? 'Свернуть' : 'Развернуть'}
            title={expanded ? 'Свернуть' : 'Контекст, подсказки и действия'}
            onClick={() => setExpanded((value) => !value)}
          >
            <svg viewBox="0 0 10 6" aria-hidden>
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
          <button className="close" title="Закрыть" aria-label="Закрыть" onClick={closeCard}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      )}

      {/* The turn is the bars above; only a failure is worth a line here. A
          successful transcript is already in the field (and the answer replaces
          it), so repeating it under the field reads as a second answer. */}
      {voice.phase === 'idle' && voice.error && voice.message && (
        <div className="line" data-tone="err">
          {voice.message}
        </div>
      )}

      {/*
        An action request that fell back to a text answer because the agent is
        enabled but blocked. The reason belongs on the folded card: the chevron
        turning accent is not an explanation.
      */}
      {blockedAction && !agentRunning && (
        <div className="line" data-tone="warn">
          <span>
            {state.agent.needsAccessibility
              ? 'Нужен доступ — без него я не нажимаю.'
              : 'Агент сейчас не может действовать.'}
          </span>
          {state.agent.needsAccessibility ? (
            <button className="tag" onClick={() => window.deskhand.permissions.open('accessibility')}>
              Открыть доступ
            </button>
          ) : (
            <button className="tag" onClick={() => window.deskhand.settings.open()}>
              Настройки
            </button>
          )}
        </div>
      )}

      {showMeta && !agentRunning && (
        <ContextDrawer
          context={context}
          flags={flags}
          drawn={drawn}
          toggleFlag={toggleFlag}
          clearDrawing={clearDrawing}
        />
      )}

      {expanded && blocked && (
        <div className="line" data-tone="warn">
          Приложение в исключениях — ничего не отправляется.
        </div>
      )}

      {expanded && setupNotice && (
        <div className="line" data-tone={setupNotice.kind === 'error' ? 'err' : 'warn'}>
          <span>{setupNotice.message}</span>
          <button className="tag" onClick={() => window.deskhand.settings.open()}>
            Настройки
          </button>
        </div>
      )}

      {expanded && hint && !blocked && !blockedAction && <div className="line">{hint}</div>}

      {/*
        An offer, not a complaint: the mode is off, so the assistant can only
        show. It appears when the card has content, when shapes were drawn, and
        when the request itself was an action — "нарисовал вместо того, чтобы
        сделать" is exactly the moment this switch is worth knowing about, and
        inside the drawer it would only be found by people who already knew.
      */}
      {agentOff && !blocked && !busy && (expanded || drawn > 0 || promptLooksLikeAction) && (
        <div className="line" data-tone={promptLooksLikeAction ? 'warn' : undefined}>
          <span>
            {promptLooksLikeAction
              ? 'Это можно было сделать, а не показать: включи управление — и я нажму сам.'
              : 'Могу и нажать за тебя — управление мышью пока выключено.'}
          </span>
          <button className="tag" onClick={() => void setAgentEnabled(true)}>
            Включить
          </button>
        </div>
      )}

      {/*
        Enabled but still blocked (almost always the Accessibility grant). The
        reason already arrived through `hint`; this adds the way out of it, since
        "нужен доступ" without a button is a dead end in a card this small.
      */}
      {expanded && agentBlocked && !blocked && !busy && !blockedAction && (
        <div className="line">
          <button className="tag" onClick={() => window.deskhand.permissions.open('accessibility')}>
            Открыть «Универсальный доступ»
          </button>
        </div>
      )}

      <AgentStatus
        agent={agent}
        done={agentDone}
        running={agentRunning}
        status={agentStatus}
        hint={agentHint}
        blockedAction={blockedAction}
        answerAgent={answerAgent}
      />

      {showWaiting && (
        <div className="waiting" role="status" aria-live="polite">
          <div className="waiting-label">Готовлю ответ…</div>
          {waitStage === 'long' ? (
            <div>Ответ занимает больше времени. Esc — остановить ответ.</div>
          ) : waitStage === 'tip' ? (
            <div>
              <span className="waiting-caption">На заметку</span>
              {waiting.tip}
            </div>
          ) : null}
        </div>
      )}

      {failure && (
        <>
          {last?.spoken && <div className="line transcript">Распознано: {last.prompt}</div>}
          <div className="line" data-tone="err">
            <span>{failure.message}</span>
            {failure.retryable && last && (
              <button className="tag" onClick={retryLast}>
                Повторить
              </button>
            )}
            {!failure.retryable && !state.setupNotice && (
              <button className="tag" onClick={() => window.deskhand.settings.open()}>
                Настройки
              </button>
            )}
          </div>
        </>
      )}

      <AnswerPanel
        answer={{
          text: answer,
          hasAnswer,
          busy,
          ready: answerReady,
          expanded,
          newText,
          ref: answerRef,
          onScroll: onAnswerScroll,
          jumpToNewText
        }}
        actions={{ copied, copy, refine }}
        speech={{
          speaking: speech.speaking,
          error: speech.error,
          toggle: () => (speech.speaking ? speech.stop() : speech.speak(answer))
        }}
        width={{ user: userWidth, wanted, toggle: toggleWidth }}
      />

      {notice && (
        <div className="line">
          <span>{notice}</span>
          {notice === AGENT_ENABLED_NOTICE && last && !busy && (
            <button className="tag" onClick={retryLast}>
              Повторить
            </button>
          )}
        </div>
      )}

      {/*
        The resize edge. It sits on the card's outermost right column, over the
        card's padding and outside the answer's scrollbar, so pulling it never
        fights a scroll gesture or a text selection.
      */}
      {hasAnswer && (
        <div
          className="grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину"
          aria-valuenow={Math.round(cardWidth)}
          aria-valuemin={wantsWide ? CARD_WIDTH : CARD_MIN_WIDTH}
          aria-valuemax={userWidthCeiling(window.screen.availWidth)}
          tabIndex={0}
          data-dragging={dragging || undefined}
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
          onKeyDown={gripKey}
        />
      )}
    </div>
  )
}
