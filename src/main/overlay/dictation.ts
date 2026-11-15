import type { ActiveAppInfo, ScreenRect } from '@shared/types'
import { helperFocused, helperFrontApplication } from '../native/helper'

interface DictationHost {
  invalidatePendingOpen(): void
  cardOnScreen(): boolean
  cardTarget(): ActiveAppInfo | null
  showField(frame: ScreenRect | null): void
  hideField(): void
  closeCard(): void
  hideCard(): void
}

export function createDictation({
  invalidatePendingOpen,
  cardOnScreen,
  cardTarget,
  showField,
  hideField,
  closeCard,
  hideCard
}: DictationHost) {
  /**
   * The app a dictation hold is typing into.
   *
   * Kept apart from `session.target`: a dictation never opens a card, and a card
   * from an earlier question may remember a different app or none at all. Read
   * at press time, before any of our windows is on screen, because the
   * frontmost app after that may be us.
   */
  let dictationTarget: ActiveAppInfo | null = null
  /**
   * Which dictation hold is reading the screen right now.
   *
   * Reading the app is a helper round trip, and a short hold can end before it
   * answers. The bump in `endDictation` is what keeps that late answer from
   * becoming the target of the next hold.
   */
  let dictationRead = 0
  /**
   * Whether the assistant card owned the keyboard when the hold began.
   *
   * Such a hold ends by closing the card, which is also what hands focus back
   * to its app. An indicator-only hold just hides the bars and leaves the app
   * the user is typing in untouched.
   */
  let dictationOwnsCard = false
  /**
   * True while a dictation owns the screen.
   *
   * A card that was already collecting context when the hold began must not
   * finish by focusing itself, and its own `generation` check cannot see that:
   * the open is legitimate, it is only the moment that is wrong.
   */
  let dictating = false

  /**
   * Remembers where a dictation hold has to paste, without opening the card.
   *
   * Opening the card means reading the selection with a synthetic ⌘C and then
   * focusing the window — both take the user out of the field they are still
   * typing in. Dictation therefore captures only the application that owns the
   * keyboard right now, which is enough for the paste and costs no context work.
   */
  async function beginDictation(): Promise<void> {
    dictating = true
    // A card still collecting context would focus itself in the middle of the
    // hold. Bumping the generation cancels that focus; `dictating` keeps its
    // cleanup from hiding the bars once they are up.
    invalidatePendingOpen()
    const mine = ++dictationRead
    const front = await helperFrontApplication()
    // A newer hold, or the end of this one, owns the answer by now.
    if (mine !== dictationRead) return
    const cardVisible = cardOnScreen()
    const ours = front?.pid === process.pid
    dictationOwnsCard = ours && cardVisible
    if (ours) {
      // The card itself was in front: the app it belongs to is the one the user
      // came from. Without a visible card (settings is frontmost) there is no
      // field behind us worth typing into.
      dictationTarget = cardVisible ? cardTarget() : null
    } else {
      dictationTarget =
        front && front.pid > 0
          ? {
              bundleId: front.bundleId,
              name: front.name,
              pid: front.pid,
              windowTitle: front.windowTitle,
              windowId: front.windowId,
              bounds: front.bounds
            }
          : null
    }
    if (!dictationTarget) {
      showField(null)
      return
    }
    // The field itself, not just the app: the border has to sit on the control
    // the keyboard is in. The read is deliberately not awaited — the bars must
    // appear at once, and a slow Accessibility tree may only cost the border.
    void markDictationField(dictationTarget, mine)
  }

  /**
   * Finds the focused control and draws its border, if it can take text.
   *
   * A non-editable focused element (a button, a web view that does not expose
   * its editor) gets no border rather than a misleading rectangle around the
   * whole window. The token check drops a late answer from a hold that has
   * already ended.
   */
  async function markDictationField(target: ActiveAppInfo, mine: number): Promise<void> {
    const focused = await helperFocused(target.pid).catch(() => null)
    if (mine !== dictationRead) return
    // The system-wide answer can belong to the card itself when the card was in
    // front at press time while the target is the app behind it. That is our
    // own input, not the field the words will go into.
    const ownElement = focused?.pid === process.pid
    showField(!ownElement && focused?.editable && focused.frame ? focused.frame : null)
  }

  /**
   * Puts the screen back after a dictation hold.
   *
   * The remembered app is dropped here: the next hold starts wherever the user
   * is by then, and a stale target would paste one sentence into the window
   * before.
   */
  function endDictation(closeAfterHold = false): void {
    const ownsCard = closeAfterHold || dictationOwnsCard
    dictating = false
    dictationRead += 1
    dictationTarget = null
    dictationOwnsCard = false
    hideField()
    if (ownsCard) {
      // `close()` bumps the generation, so an in-flight `openInternal` cannot
      // focus an empty card after the key is already up. That is also what
      // returns focus to the app behind a primary-hotkey dictation turn.
      closeCard()
      return
    }
    hideCard()
  }

  return {
    beginDictation,
    endDictation,
    isActive: () => dictating,
    target: () => (dictating ? dictationTarget : cardTarget())
  }
}
