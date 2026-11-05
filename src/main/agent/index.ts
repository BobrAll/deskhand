/**
 * The agent runner: takes a plan and performs it with the real mouse and keyboard.
 *
 * Three rules shape everything in this file.
 *
 * **1. The user can always stop it.** Escape and a physical mouse movement are
 * watched for the whole run, the pause before the first action exists so that a
 * changed mind still wins, and the card offers a "Стоп" while it runs. An agent
 * that cannot be interrupted is not a feature, it is a hostage situation.
 *
 * **2. Nothing is executed that was not asked for.** Coordinates are clamped,
 * shortcuts are parsed against a known table, and a step that cannot be resolved
 * is skipped with a message instead of being approximated. A wrong click is
 * worse than a missing one: it lands somewhere the user did not agree to.
 *
 * **2b. The click lands on the element, not on the model's guess.** A model
 * looking at a downscaled screenshot is routinely twenty to sixty points off, so
 * the point it returns is only used to decide *which* control it meant; the exact
 * pixel comes from the Accessibility API's rectangle for that control (see
 * `targeting.ts`). Without a tree to ask — a canvas app, a game, no permission —
 * the guess is used as-is, and that is the only case where a click is approximate.
 *
 * **3. The card must not eat the click.** The overlay window is made
 * click-through for the duration of the run, and the app the plan is about is
 * brought back to the front first — otherwise the assistant would click its own
 * bubble.
 */

import { dialog, screen, systemPreferences, type BrowserWindow } from 'electron'
import type {
  AgentAction,
  AgentAvailability,
  AgentEvent,
  AgentPlanStep,
  AgentRunRequest,
  AxProbe,
  ScreenRect
} from '@shared/types'
import {
  helperActivate,
  helperBinary,
  helperClick,
  helperDrag,
  helperMoveMouse,
  helperPressKey,
  helperFocused,
  helperProbe,
  helperScroll,
  helperTypeText,
  helperFront,
  watchForAbort,
  type AbortWatcher
} from '../native/helper'
import { getSettings, patchSettings } from '../settings/store'
import { delay, waitFor } from '../util'
import { hideAgentCursor } from './cursor'
import { toScreenPoint as toScreen, type ScreenPoint } from './geometry'
import { describeShortcut, parseShortcut } from './keys'
import { isTextField, resolveTarget, type TargetResolution } from './targeting'
import { approvalKey, assessAction } from './safety'

export interface AgentHost {
  /** Parent required for a cancellable, asynchronous macOS confirmation sheet. */
  confirmationWindow?(): BrowserWindow | null
  /** Makes the card ignore the mouse (and stop being frontmost) while a plan runs. */
  setPassthrough(active: boolean): void
  /** Reports progress to the card. */
  emit(event: AgentEvent): void
  /** The app the plan is about: brought to the front before the first click. */
  target(): { bundleId: string; pid: number } | null
}

export interface AgentRunResult {
  /** `true` when the plan ended with `@done` — the model considers it finished. */
  finished: boolean
  /** Set when the run stopped early (an abort, a missing permission). */
  message?: string
  /** No input was delivered to the wrong target; a fresh plan may recover. */
  recoverable?: boolean
  /** What actually happened, for the continuation prompt. */
  performed: PerformedStep[]
}

/** One action that ran, as the continuation prompt describes it. */
interface PerformedStep {
  label: string
  ok: boolean
}

const EMPTY: AgentEvent = { phase: 'idle', step: 0, total: 0, label: '', plan: [] }

/**
 * Hard ceiling on one plan.
 *
 * The watcher is a safety net, not the normal path: if a step hangs (a click on
 * an app that stopped responding), the timeout is what stops the card from
 * staying click-through and Escape from being captured forever.
 */
const RUN_TIMEOUT_MS = 60_000

export function createAgentController(host: AgentHost) {
  let watcher: AbortWatcher | null = null
  /** Bumped by `stop()`; a running plan compares it and gives up. */
  let run = 0
  let running = false
  let confirming = false
  let approval: AbortController | null = null
  let last: AgentEvent = EMPTY

  /**
   * Whether the mode can be used at all right now.
   *
   * Synchronous on purpose: the answer is needed while the overlay state is being
   * built, and spawning the helper just to ask a question Electron can answer
   * from its own cache would add a round trip to every hotkey press. Three
   * separate reasons, because they have three different fixes — the overlay
   * prints the reason instead of offering an action that would quietly do
   * nothing.
   */
  function availability(): AgentAvailability {
    const settings = getSettings()
    if (!settings.agent.enabled) {
      return { enabled: false, ready: false, reason: 'Агентный режим выключен в настройках.' }
    }
    if (!helperBinary()) {
      return {
        enabled: true,
        ready: false,
        reason: 'Нативный helper не собран — управлять мышью нечем.'
      }
    }
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      trusted = false
    }
    if (!trusted) {
      return {
        enabled: true,
        ready: false,
        reason: 'Нужен доступ «Универсальный доступ», иначе macOS не даст нажимать за вас.'
      }
    }
    return { enabled: true, ready: true, reason: null }
  }

  function publish(event: Partial<AgentEvent> & { phase: AgentEvent['phase'] }): void {
    last = {
      phase: event.phase,
      step: event.step ?? last.step,
      total: event.total ?? last.total,
      label: event.label ?? last.label,
      plan: event.plan ?? last.plan,
      skipped: event.skipped ?? last.skipped,
      message: event.message
    }
    host.emit(last)
  }

  /**
   * What the Accessibility API last said about the screen, and what it is saying
   * right now.
   *
   * Reading the tree costs a couple of hundred milliseconds — every attribute is
   * a round trip into the target app — so it is cached for one step and refreshed
   * for the *next* step while the current step's pause is running. The generation
   * counter is what keeps a prefetch that was started against the old screen from
   * landing in the cache after the screen changed under it.
   */
  let probe: { at: ScreenPoint; value: AxProbe | null; capturedAt: number } | null = null
  let probeLoading: { at: ScreenPoint; promise: Promise<AxProbe | null> } | null = null
  let probeGeneration = 0

  /**
   * The app the plan is working in *now*.
   *
   * `host.target()` is the app the card was opened in, and it stays frozen for
   * the whole session. A plan that walks the user into another app — System
   * Settings, a dialog, a second window — leaves that answer behind, and every
   * step after the first has to aim at what is in front at that moment: reading
   * the tree of the app we started in describes a screen that is no longer on
   * the display, and snapping a click against it puts the pointer on a control
   * the model never saw.
   */
  let working: { bundleId: string; pid: number } | null = null

  async function refreshWorking(): Promise<void> {
    const front = await helperFront()
    if (!front || front.pid === process.pid) return
    if (front.pid !== working?.pid) forgetProbe()
    working = { bundleId: front.bundleId, pid: front.pid }
  }

  /**
   * How old a cached tree may be and still be used for a click.
   *
   * A menu animation is 150–200 ms long, and a tree read in the middle of one
   * describes a screen that no longer exists — the items are there but at the
   * wrong place, or not there at all. The prefetch deliberately starts *after*
   * that window (see the step delay), and this is the backstop: anything older
   * than a step is re-read rather than trusted.
   */
  const PROBE_FRESH_MS = 1500

  function samePoint(a: ScreenPoint, b: ScreenPoint): boolean {
    return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2
  }

  /** The elements of the target app, as of now. `null` when it cannot answer. */
  function probeAt(point: ScreenPoint): Promise<AxProbe | null> {
    if (probe && samePoint(probe.at, point) && Date.now() - probe.capturedAt < PROBE_FRESH_MS) {
      return Promise.resolve(probe.value)
    }
    if (probeLoading && samePoint(probeLoading.at, point)) return probeLoading.promise

    const generation = probeGeneration
    const target = working ?? host.target()
    const promise = helperProbe(target && target.pid > 0 ? target.pid : null, point).then(
      (value) => {
        // Our own card is never a target: it sits in front of the app while the
        // answer streams, and its buttons are not what the model looked at.
        const usable = value && value.pid !== process.pid ? value : null
        if (generation === probeGeneration) {
          probe = { at: point, value: usable, capturedAt: Date.now() }
          if (probeLoading?.promise === promise) probeLoading = null
        }
        return usable
      }
    )
    probeLoading = { at: point, promise }
    return promise
  }

  /** Drops the cached tree: something was pressed and the screen is not the same. */
  function forgetProbe(): void {
    probeGeneration += 1
    probe = null
    probeLoading = null
  }

  /** The model's point for a step, before anything on the screen is consulted. */
  function roughPoint(action: AgentAction, area: ScreenRect): ScreenPoint | null {
    if (action.kind === 'click' || action.kind === 'move') return toScreen(action.at, area)
    return null
  }

  /**
   * Where a step should actually click.
   *
   * Returns null for steps that have no point of their own. The resolution carries
   * its own confidence, and the caller only uses the point: the difference between
   * "нажал кнопку" and "нажал рядом с кнопкой" is not something the model gets to
   * decide, but it is something the screen knows.
   */
  async function aim(
    action: AgentAction,
    area: ScreenRect
  ): Promise<{ point: ScreenPoint; target: TargetResolution } | null> {
    if (action.kind !== 'click' && action.kind !== 'move') return null
    const rough = toScreen(action.at, area)
    const info = await probeAt(rough)
    const target = resolveTarget({ rough, label: action.label ?? null, probe: info, area })
    return { point: target.point, target }
  }

  /**
   * Why typing must not happen now, or null when it may.
   *
   * The plan is "click the field, then type", and the click on a small field is
   * exactly the step a model's coordinates get wrong. Without this check the text
   * is delivered to whatever the miss left focused — a button, a link, a menu —
   * and "впиши адрес" becomes keystrokes into the wrong control.
   *
   * One-sided on purpose: only a *known control* in focus can block the step. An
   * app that reports no focus at all gets the benefit of the doubt, because a
   * false "не вижу поля" would break typing that works today.
   */
  async function typingBlocked(): Promise<string | null> {
    const target = working ?? host.target()
    const focused = await helperFocused(target && target.pid > 0 ? target.pid : null)
    if (!focused || !focused.role) return null
    // The keyboard may belong to another app — the activation failed, or the user
    // clicked elsewhere — and then its focus says nothing about the plan's target.
    if (target && focused.pid && focused.pid !== target.pid) return null
    if (isTextField(focused) !== false) return null
    if (focused.pressable !== true) return null
    const what = focused.title ? `«${focused.title}»` : (focused.roleDescription ?? 'элемент')
    return `Поле ввода не в фокусе (сейчас в фокусе ${what}) — текст не введён.`
  }

  /** One action. Returns false when the step could not be performed. */
  async function perform(
    action: AgentAction,
    area: ScreenRect,
    aimed: ScreenPoint | null
  ): Promise<boolean> {
    switch (action.kind) {
      case 'move': {
        const point = aimed ?? toScreen(action.at, area)
        return helperMoveMouse(point.x, point.y)
      }
      case 'click': {
        const point = aimed ?? toScreen(action.at, area)
        return helperClick(point.x, point.y, action.button)
      }
      case 'drag': {
        const from = toScreen(action.from, area)
        const to = toScreen(action.to, area)
        return helperDrag(from, to)
      }
      case 'scroll':
        return helperScroll(action.dx, action.dy)
      case 'type':
        return helperTypeText(action.text)
      case 'key': {
        const parsed = parseShortcut(action.combo)
        if (!parsed) return false
        return helperPressKey(parsed.keyCode, parsed.flags)
      }
      case 'wait':
        await delay(Math.min(action.ms, 10_000))
        return true
      case 'done':
        return true
      default:
        return false
    }
  }

  /**
   * Runs one plan.
   *
   * The steps are performed one at a time with a pause between them: the delay
   * is what makes the run watchable, and a run nobody can watch is a run nobody
   * can interrupt. The window is made click-through *before* the first action and
   * restored afterwards, whatever the outcome.
   */
  async function execute(
    request: AgentRunRequest & { skipped?: string[] }
  ): Promise<AgentRunResult> {
    const settings = getSettings()
    // Freeze the proposed inputs while a human reviews them.
    request = structuredClone(request)
    const plan = request.steps
    const labels = plan.map((step) => step.label)
    const total = plan.length
    const performed: PerformedStep[] = []

    if (running) return { finished: false, message: 'Агент уже выполняет действие.', performed }

    if (!settings.agent.enabled) {
      const message = 'Агентный режим выключен в настройках.'
      publish({ phase: 'error', message })
      return { finished: false, message, performed }
    }
    if (!request.area) {
      const message = 'Неизвестно, где на экране цель — нажимать некуда.'
      publish({ phase: 'error', message })
      return { finished: false, message, performed }
    }
    if (total === 0) return { finished: false, performed }

    const token = ++run
    running = true
    const aborted: { reason: 'escape' | 'mousemove' | null } = { reason: null }

    // The card is a normal window and it holds the keyboard while the answer
    // streams, so the app the plan is about has to come back to the front or the
    // first click lands on the bubble. Two cases where it must not: the app is
    // already in front (nothing to restore), and — the one that matters — a
    // third app is. That third app is where the last round walked the user
    // (System Settings, a dialog, a window the plan just opened), and it is what
    // the remaining steps were written against; re-activating the app the card
    // was opened in puts the old window in front of that screen and every step
    // after it lands somewhere nobody planned for — "переключилось не на ту
    // вкладку, всё слетело".
    const opened = host.target()
    host.setPassthrough(true)
    const before = await helperFront()
    const inFrontOfTarget = Boolean(
      before && opened && (before.pid === opened.pid || (before.bundleId && before.bundleId === opened.bundleId))
    )
    const cardFocused = !before || before.pid === process.pid
    if (opened && (cardFocused || inFrontOfTarget)) {
      await helperActivate(opened)
      await waitFor(async () => {
        const front = await helperFront()
        if (!front) return false
        if (front.bundleId && front.bundleId === opened.bundleId) return true
        return opened.pid > 0 && front.pid === opened.pid
      }, 1200, 60)
    }

    // Whoever is in front now is the app this round aims at — its Accessibility
    // tree is the one the clicks are snapped against. When we cannot tell (no
    // permission, no window), the app the card was opened in is still the best
    // guess we have.
    const front = await helperFront()
    working = front && front.pid !== process.pid ? { bundleId: front.bundleId, pid: front.pid } : opened

    watcher = watchForAbort({ watchMouse: settings.agent.abortOnMouseMove }, (reason) => {
      if (confirming && reason === 'mousemove') return
      if (aborted.reason) return
      aborted.reason = reason
      approval?.abort()
    })

    publish({
      phase: 'arming',
      step: 0,
      total,
      label: 'Приготовился',
      plan: labels,
      skipped: request.skipped
    })

    /**
     * Announces the end of a plan.
     *
     * Normally that is «Готово», and the card takes it as the truth. When the
     * caller said it is going to check the result on a fresh screenshot
     * (`request.verify`), the word is withheld: the runner has no evidence yet,
     * and a «Готово» for half a second followed by "не получилось" is worse than
     * no word at all. The caption then describes what happens next, and the
     * verdict arrives from whoever looked.
     */
    const done = (progress: { step: number; total: number; claimed: boolean }): void => {
      publish({
        phase: 'done',
        step: progress.step,
        total: progress.total,
        // Two words, two meanings, and the difference matters to the user: «Готово»
        // is the model saying the task is finished (`@done`), «Выполнено» is the
        // runner saying the steps ran out without such a claim. Neither is spoken
        // when a check is coming: then the label describes the next moment, and the
        // verdict arrives from whoever looked at the screen.
        label: request.verify ? 'Проверяю результат' : progress.claimed ? 'Готово' : 'Выполнено',
        plan: labels
      })
    }

    const deadline = setTimeout(() => {
      if (!aborted.reason) aborted.reason = 'escape'
      approval?.abort()
    }, RUN_TIMEOUT_MS)

    try {
      // The window in which Escape still wins. 900 ms by default: long enough to
      // notice a wrong plan, short enough not to feel broken.
      const arming = settings.agent.startDelayMs
      // The tree for the first click is read while the plan is still "приготовился",
      // not after it: a probe costs a couple of hundred milliseconds and this is
      // the one pause the run already has. Not awaited on purpose — Escape must
      // end the run without waiting for the Accessibility API to answer.
      const first = plan[0]
      const firstRough = first ? roughPoint(first.action, request.area) : null
      if (firstRough) void probeAt(firstRough)
      if (arming > 0) await delay(arming)
      // Stopped before the first click: `stop()` published the "Остановлено" the
      // user saw, and the message is what tells the caller this turn was
      // cancelled rather than completed — a cancelled turn must not go on to be
      // checked and reported as a result.
      if (token !== run) return { finished: false, message: 'Остановлено.', performed }

      for (let index = 0; index < plan.length; index += 1) {
        if (token !== run) break
        if (aborted.reason) break

        const step = plan[index]
        if (step.action.kind === 'done') {
          done({ step: index + 1, total, claimed: true })
          return { finished: true, performed }
        }

        await refreshWorking()
        if (token !== run || aborted.reason) break

        // A permission check per step is cheap (one `front` call) and is what
        // makes the failure message honest instead of "клик не сработал".
        // Cheap, and it is what makes a failure message honest instead of
        // "клик не сработал": a disabled capability is named before anything runs.
        const guard = guardStep(step)
        if (guard) {
          publish({ phase: 'error', step: index + 1, total, label: step.label, message: guard })
          return { finished: false, message: guard, performed }
        }

        // Typing is checked against the real focus, not against the plan: if the
        // click that was supposed to land in the field landed next to it, the text
        // must not be typed into whatever is actually focused.
        if (step.action.kind === 'type') {
          const blocked = await typingBlocked()
          if (blocked) {
            publish({ phase: 'error', step: index + 1, total, label: step.label, message: blocked })
            return { finished: false, message: blocked, recoverable: true, performed }
          }
        }

        // Aim before acting: the model's point picks the region, the rectangle the
        // Accessibility API reports picks the pixel.
        const aimed = await aim(step.action, request.area)
        if (token !== run || aborted.reason) break

        // The point sits inside a control whose name is not the label the model
        // wrote — one row off in a dense list, which is how "открой «Клавиатура»"
        // turns into a click on the row above it and the wrong pane opens. A
        // click that is known to be on the wrong control is not "чуть неточно",
        // it is a different action, so the step is reported instead of pressed:
        // the plan stops here, where the user can read why, rather than two
        // steps later on a screen nobody planned for.
        if (aimed?.target.conflict) {
          const message = `Под точкой «${aimed.target.conflict}», а не «${step.label}» — не нажимаю.`
          publish({ phase: 'error', step: index + 1, total, label: step.label, message })
          return { finished: false, message, recoverable: true, performed }
        }

        const focus = step.action.kind === 'type' || step.action.kind === 'key'
          ? await helperFocused(working?.pid ?? null) : null
        if (token !== run || aborted.reason) break
        const element = aimed?.target.element ?? focus
        const safety = assessAction(step, element, working?.bundleId)
        const approvalId = safety.kind === 'confirm' ? approvalKey(step, element, working?.bundleId) : null
        const remembered = approvalId && getSettings().agent.rememberedApprovals.includes(approvalId)
        let rememberApproval = false
        let safetyMessage: string | null = safety.kind === 'deny' ? safety.reason : null
        if (safety.kind === 'confirm' && !remembered) {
          const approvedTarget = working ? { ...working } : null
          confirming = true
          let accepted = false
          try {
            const parent = host.confirmationWindow?.()
            if (!parent || parent.isDestroyed()) throw new Error('Confirmation window unavailable')
            approval = new AbortController()
            host.setPassthrough(false)
            const answer = await dialog.showMessageBox(parent, {
              signal: approval.signal,
              type: 'warning',
              title: 'Подтверждение действия агента',
              message: 'Разрешить действие?',
              detail: `Приложение: ${approvedTarget?.bundleId || 'неизвестно'}\n${safety.detail}`,
              buttons: approvalId ? ['Отменить', 'Разрешить один раз', 'Разрешить всегда'] : ['Отменить', 'Разрешить один раз'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            })
            rememberApproval = Boolean(approvalId && answer.response === 2)
            accepted = answer.response === 1 || rememberApproval
          } catch {
            // A missing dialog must never silently grant permission.
          } finally {
            confirming = false
            approval = null
            if (token === run && !aborted.reason) host.setPassthrough(true)
          }
          if (token !== run || aborted.reason) break
          if (!accepted) safetyMessage = 'Действие отменено. Агент остановлен.'
          else if (!approvedTarget) safetyMessage = 'Неизвестно целевое приложение. Действие отменено.'
          else {
            // Dialog focus must not become the destination of approved input.
            await helperActivate(approvedTarget)
            const front = await helperFront()
            forgetProbe()
            const freshAim = await aim(step.action, request.area)
            const freshFocus = step.action.kind === 'type' || step.action.kind === 'key'
              ? await helperFocused(approvedTarget.pid) : null
            if (front?.pid !== approvedTarget.pid ||
                JSON.stringify(freshAim) !== JSON.stringify(aimed) ||
                JSON.stringify(freshFocus) !== JSON.stringify(focus)) {
              safetyMessage = 'Цель изменилась во время подтверждения. Действие отменено; нужен новый план.'
            }
          }
        }
        if (token !== run || aborted.reason) break
        const latestGuard = !getSettings().agent.enabled ? 'Агентный режим выключен.' : guardStep(step)
        if (safetyMessage || latestGuard) {
          const message = safetyMessage ?? latestGuard!
          publish({ phase: 'error', step: index + 1, total, label: step.label, message })
          return { finished: false, message, performed }
        }

        // A resolution that found nothing on the screen is a guess, and the card
        // says so: "Клик" and "Клик · на глаз" are different promises, and the
        // second one is the case where a missing action is nobody's mystery.
        const label = aimed && aimed.target.source === 'model' ? `${step.label} · на глаз` : step.label
        publish({ phase: 'acting', step: index + 1, total, label, plan: labels })
        if (rememberApproval && approvalId) {
          const agent = getSettings().agent
          patchSettings({ agent: { ...agent, rememberedApprovals: [...agent.rememberedApprovals, approvalId] } })
        }
        const ok = await perform(step.action, request.area, aimed?.point ?? null)
        performed.push({ label: step.label, ok })
        // Whatever happened, the screen is not the same place: a menu opened, a
        // field took focus, a list re-sorted. The next step must not aim at a map
        // of the previous screen.
        forgetProbe()
        if (!ok) {
          const message = `Не удалось выполнить: ${step.label}`
          publish({ phase: 'error', step: index + 1, total, label: step.label, message })
          return { finished: false, message, performed }
        }

        if (index < plan.length - 1 && settings.agent.stepDelayMs > 0) {
          // The pause is also where the next step's tree is read: the cost is the
          // same, but the user sees a deliberate beat instead of a slow click.
          //
          // The read starts *after* the click has visibly taken effect. Reading
          // the tree the instant the click is posted catches a menu half-way
          // open — items present but spread across the window, or not yet there —
          // and a map of that state aims the next step at a place that by then
          // no longer exists.
          const delayMs = settings.agent.stepDelayMs
          const settle = Math.min(220, Math.round(delayMs * 0.55))
          if (settle > 0) await delay(settle)
          await refreshWorking()
          const next = plan[index + 1]
          const nextRough = next ? roughPoint(next.action, request.area) : null
          if (nextRough) void probeAt(nextRough)
          if (delayMs > settle) await delay(delayMs - settle)
        }
      }

      if (aborted.reason) {
        const message =
          aborted.reason === 'escape'
            ? 'Остановлено по Escape.'
            : 'Остановлено: вы взяли мышь.'
        publish({ phase: 'aborted', label: '', message })
        return { finished: false, message, performed }
      }
      // Same for a stop between two steps of a longer plan: half the sequence ran,
      // so there is no result to judge.
      if (token !== run) return { finished: false, message: 'Остановлено.', performed }

      done({ step: total, total, claimed: false })
      return { finished: false, performed }
    } finally {
      clearTimeout(deadline)
      watcher?.stop()
      watcher = null
      host.setPassthrough(false)
      // Safety net for a throw between two publishes: whatever happened, the
      // ring must not be left sitting on the user's pointer.
      hideAgentCursor()
      running = false
      // The next round resolves its own working app; a stale one would describe
      // an app that step has already left.
      working = null
    }
  }

  /** Settings that make a step impossible, checked before anything is posted. */
  function guardStep(step: AgentPlanStep): string | null {
    const settings = getSettings()
    if (step.action.kind === 'type' && !settings.agent.allowTyping) {
      return 'Печать отключена в настройках агента.'
    }
    if (step.action.kind === 'key') {
      if (!settings.agent.allowShortcuts) return 'Горячие клавиши отключены в настройках агента.'
      if (!parseShortcut(step.action.combo)) return `Неизвестная комбинация: ${step.action.combo}`
    }
    return null
  }

  /** Stops the run in flight. Safe to call when nothing is running. */
  function stop(): void {
    run += 1
    approval?.abort()
    watcher?.stop()
    watcher = null
    if (running) publish({ phase: 'aborted', label: '', message: 'Остановлено.' })
    host.setPassthrough(false)
    // execute() owns the lock until its pending confirmation/helper has settled.
  }

  /**
   * Where the pointer is now, in screen points. Used to describe a run that was
   * interrupted — "остановился вот здесь" is easier to trust than a silent stop.
   */
  function pointer(): { x: number; y: number } {
    const point = screen.getCursorScreenPoint()
    return { x: Math.round(point.x), y: Math.round(point.y) }
  }

  return {
    availability,
    execute,
    stop,
    pointer,
    isRunning: (): boolean => running,
    last: (): AgentEvent => last,
    /** Shortcut as the card should print it. */
    describe: describeShortcut
  }
}

