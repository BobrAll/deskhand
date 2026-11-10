/**
 * Everything a turn sends to the model, assembled in one place.
 *
 * This used to be the head of `send()` in `overlay/index.ts`, mixed in with
 * the window, the session and the stream. It is the one part of a turn that does
 * not move the screen, so it is the one part that can be tested without an
 * Electron window — and the part where a silent change would be a behaviour
 * change, because the prompt format is frozen (правило 1).
 *
 * What stays outside, and arrives as callbacks:
 *
 * - `ensureFreshScreenshot()` — an `await` that takes a picture of the screen.
 *   It touches the host window (content protection) and the session, so it is the
 *   caller's business; here it is just "make sure the snapshot is current".
 * - `describeScreen()` — an `await` around the Accessibility probe. Same reason:
 *   it spawns the helper.
 *
 * The two callbacks are called in the same order and under the same conditions as
 * before, so the sequence of side effects is unchanged.
 */

import type { ActiveAppInfo, ContextSnapshot, ScreenRect, SendRequest, ScreenshotInfo } from '@shared/types'
import { allowsWebLookup } from '@shared/intent'
import { imagePart } from '../imagePart'
import { buildRefine, buildRequest, MAX_REFINE_TOKENS, withPreviousCommand } from '../prompt'
import type { ChatMessage, ContentPart } from '../llm/provider'

/** One question and the answer it got, as the model sees it. */
export interface Exchange {
  question: string
  answer: string
}

/** The settings fields the request depends on. */
export interface RequestSettings {
  systemPrompt: string
  maxTokens: number
}

/** What the caller knows about the session the request belongs to. */
export interface RequestSession {
  snapshot: ContextSnapshot
  history: Exchange[]
  target: ActiveAppInfo | null
}

export interface BuildTurnRequestInput {
  request: SendRequest
  session: RequestSession
  history?: Exchange[]
  previousCommand?: string
  settings: RequestSettings
  /** Whether the chosen provider/model can take an image at all. */
  visionSupported: boolean
  /** Whether acting is allowed at all, and why not when it is not. */
  availability: { ready: boolean; reason: string | null }
  /** Takes a fresh screenshot when the current one is too old. */
  ensureFreshScreenshot: () => Promise<ScreenshotInfo | null>
  /** Reads names and coordinates for drawing and acting. Best effort. */
  describeScreen: (
    pid: number | null,
    bounds: ScreenRect | null,
    area: ScreenRect
  ) => Promise<string | null>
  /** Whether the abort signal has fired since the last await. */
  aborted: () => boolean
}

export interface TurnRequest {
  messages: ChatMessage[]
  maxTokens: number
  /** Whether the image goes with this request. */
  useImage: boolean
  screenshot: ScreenshotInfo | null
  /** The rectangle every returned coordinate refers to, or `null` without an image. */
  area: ScreenRect | null
  canDraw: boolean
  /** The request was abandoned while a screenshot was being taken. */
  abandoned: boolean
}

/**
 * Appended to the system message when the question is about public facts, so the
 * model knows it may answer with a search marker. Model-facing text: frozen.
 */
const WEB_LOOKUP_INSTRUCTION = [
  '[Фоновый поиск в интернете]',
  'Выбирай инструмент по тому, какой результат просит пользователь.',
  'Для ответа, который требует найти или проверить общедоступные сведения, верни только @web.',
  'Это относится и к просьбам «поищи» или «погугли», когда результатом должны быть сведения.',
  'Если нужен переход на страницу или действие в конкретном интерфейсе, используй экранные инструменты.',
  'Если сведения нужны из текущего окна, документа или личного аккаунта, используй этот контекст.',
  'Выполняй действия только по просьбе пользователя.',
  'Если поиск не нужен, сразу дай обычный ответ.'
].join('\n')

/** «Длиннее» at least doubles the token ceiling, and never below this floor. */
const REFINE_MIN_TOKENS = 1024
const REFINE_TOKEN_FACTOR = 2

/**
 * Builds the request for one turn.
 *
 * Returns `abandoned: true` when the abort fired during the fresh capture: the
 * caller then leaves the turn alone, exactly as it did when the `await` lived
 * inside `send()`.
 */
export async function buildTurnRequest(input: BuildTurnRequestInput): Promise<TurnRequest> {
  const { request, session, settings } = input
  const history = input.history ?? session.history
  const refine = request.refine ?? null
  const previousCommand = refine ? undefined : input.previousCommand
  const baseAnswer = refine ? refine.baseAnswer.trim() : ''

  // The drawing and acting tools are offered with every request that carries an
  // image: the assistant decides for itself whether an answer is better shown,
  // or done, than written. The image is the precondition, not a mode.
  const wantImage = Boolean(!refine && request.includeScreenshot)

  // ТЗ §5.2: the image must show the screen *at request time*. The snapshot is
  // taken when the overlay opens, which can be minutes earlier (the user reads
  // the answer, types, asks a follow-up), so a fresh capture is taken here for
  // every request that actually sends an image.
  let shot: ScreenshotInfo | null = null
  if (wantImage && input.visionSupported) {
    shot = await input.ensureFreshScreenshot()
    if (input.aborted()) {
      return {
        messages: [],
        maxTokens: settings.maxTokens,
        useImage: false,
        screenshot: null,
        area: null,
        canDraw: false,
        abandoned: true
      }
    }
  }

  const image = shot ? imagePart(shot.dataUrl) : null
  const useImage = image !== null

  // The rectangle the model is looking through. Captured once, before the
  // request, because it is the frame every returned coordinate refers to: a live
  // re-capture mid-stream must not shift the shapes already being painted.
  const area = shot ? shot.area : session.snapshot.screenshot?.area ?? null
  // Drawing and acting are only honest when the model can actually see the
  // target. Without an image the coordinates would be invented, and a confident
  // arrow — or worse, a confident click — aimed at the wrong pixel is worse
  // than a plain answer, so neither tool is offered then.
  const canDraw = useImage && area != null
  /**
   * Why the assistant may look but not touch.
   *
   * Acting is a separate turn, handed to the agent (`agent/index.ts`), so this
   * note only covers the case where that route is closed: the mode is off or
   * macOS has not granted Accessibility. It is passed on only when there is an
   * image — that is exactly the situation where «нажми» used to come back as a
   * circled button with no explanation. Without an image there is nothing to
   * confuse, and the note would be noise.
   */
  const actReason = canDraw && !input.availability.ready ? input.availability.reason : null

  /**
   * The exact names of what can be pressed, from the Accessibility API.
   *
   * It is what makes a click land on the row the model named instead of the
   * one it measured: asked for «Тёмная тема», a model looking at a downscaled
   * picture writes a point that is one row off and the pane that opens is the
   * neighbouring one. With the names in the prompt the point stops being a
   * guess. Best effort — an app that answers nothing just yields no list.
   */
  const outline = canDraw
    ? await input
        .describeScreen(
          session.target?.pid ?? null,
          session.snapshot.activeApp?.bounds ?? null,
          area as ScreenRect
        )
        .catch(() => null)
    : null

  const { userText, modeInstruction } = refine
    ? buildRefine({
        direction: refine.direction,
        baseAnswer,
        mode: request.mode,
        originalPrompt: request.prompt
      })
    : buildRequest({
        prompt: request.prompt,
        mode: request.mode,
        snapshot: { ...session.snapshot, screenshot: shot },
        includeSelection: request.includeSelection,
        // The effective value, not the chip: an image sent with the request is
        // what the prompt has to describe.
        requestedScreenshot: request.includeScreenshot || useImage,
        imageAttached: useImage,
        draw: canDraw,
        actReason,
        hasHistory: history.length > 0 || Boolean(previousCommand),
        outline
      })

  const parts: ContentPart[] = []
  if (image) parts.push(image)
  parts.push({ type: 'text', text: withPreviousCommand(userText, previousCommand) })

  // The conversation, not just the last sentence: without these turns "а
  // почему?" reaches the model as a question about nothing. They are text-only
  // on purpose — an old screenshot would be a picture of a screen that has
  // already changed, and the model would reason about the wrong frame — and the
  // context block is not repeated either: the app, the window and the selection
  // are described once, in the current message.
  //
  // A rewrite ("короче") deliberately gets no history: its whole input is the
  // answer being reworked, and extra turns would let the model drift away from
  // the text the user is looking at.
  const historyMessages: ChatMessage[] = refine
    ? []
    : history.flatMap((exchange): ChatMessage[] => [
        { role: 'user', parts: [{ type: 'text', text: exchange.question }] },
        { role: 'assistant', parts: [{ type: 'text', text: exchange.answer }] }
      ])

  const messages: ChatMessage[] = [
    {
      role: 'system',
      parts: [{
        type: 'text',
        text: [
          settings.systemPrompt.trim(),
          modeInstruction,
          !refine && allowsWebLookup(request.prompt) ? WEB_LOOKUP_INSTRUCTION : ''
        ].filter(Boolean).join('\n\n')
      }]
    },
    ...historyMessages,
    { role: 'user', parts }
  ]

  // "Длиннее" must be able to actually grow the answer, so the token ceiling is
  // raised (bounded) instead of staying at whatever the summary needed.
  const maxTokens =
    refine?.direction === 'longer'
      ? Math.min(MAX_REFINE_TOKENS, Math.max(settings.maxTokens * REFINE_TOKEN_FACTOR, REFINE_MIN_TOKENS))
      : settings.maxTokens

  return {
    messages,
    maxTokens,
    useImage,
    screenshot: shot,
    area,
    canDraw,
    abandoned: false
  }
}
