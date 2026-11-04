/**
 * Three-finger trackpad gestures.
 *
 * One gesture, two actions, and the only thing that separates them is time:
 *
 *   tap  (short)  -> the card opens, exactly as if the global hotkey was pressed
 *   hold (longer) -> recording starts, and it stops when the fingers come up
 *
 * Both are *additive*: the keyboard shortcuts keep working, so this module is a
 * second input path into the same two places — `open()` for the tap and the voice
 * controller's own state machine for the hold. Nothing here duplicates the voice
 * pipeline; a gesture press is simply another press.
 *
 * The classification itself lives in the native helper (see `helper.m`), because
 * that is where the contact frames are: a quick tap lifts before all three
 * fingers share a frame, so only a whole contact can be told from a hold.
 */

import type { GestureSettings } from '@shared/types'
import { helperBinary } from '../native/helper'
import { getSettings } from '../settings/store'
import { TrackpadGestureListener, type GestureEvent } from './listen'

export interface GestureHost {
  /** Opens the card, the same call the global hotkey makes. */
  open(): Promise<void>
  /** True while the card is on screen, so a tap does not rebuild it. */
  isOpen(): boolean
  /** The microphone edges of a hold, routed into the voice state machine. */
  press(): void
  release(): void
  cancel(): void
}

export function createGestureController(host: GestureHost) {
  let listener: TrackpadGestureListener | null = null
  /** `fingers:holdMs` the running helper was started with, to avoid restarts. */
  let running: string | null = null
  /** Set when the trackpad listener could not be started. */
  let listenerError: string | null = null

  function onEvent(event: GestureEvent): void {
    if (event === 'ready') return
    if (event === 'tap') {
      // A tap is "show me the field": it opens the card and nothing else. It is
      // deliberately not routed through the voice state machine, because that
      // would start a recording on every brush of the pad.
      if (host.isOpen()) return
      void host.open()
      return
    }
    // press / release / cancel belong to the microphone, and that path already
    // knows what to do when voice input is switched off.
    if (event === 'press') host.press()
    else if (event === 'release') host.release()
    else host.cancel()
  }

  /** (Re)starts the listener from the current settings. Safe to call repeatedly. */
  function applySettings(): void {
    const gestures: GestureSettings = getSettings().gestures
    const binary = helperBinary()

    if (!gestures.enabled) {
      listener?.stop()
      listener = null
      running = null
      listenerError = null
      return
    }
    if (!binary) {
      listenerError = 'Нативный helper не найден — жесты тремя пальцами недоступны.'
      return
    }

    // The finger count and the hold threshold are launch arguments of the helper
    // process, so a change to either is a restart. An unchanged configuration
    // leaves a running listener alone: restarting it on every settings save would
    // drop the gesture the user is in the middle of making.
    const wanted = `${gestures.fingers}:${gestures.holdMs}`
    if (listener && running === wanted && listener.listening) return

    listener?.stop()
    listener = new TrackpadGestureListener({
      binary,
      fingers: gestures.fingers,
      holdMs: gestures.holdMs,
      onEvent,
      onError: (message) => {
        listenerError = message
        console.warn('[gesture]', message)
      }
    })
    running = wanted
    listenerError = listener.start() ?? null
  }

  function stop(): void {
    listener?.stop()
    listener = null
    running = null
  }

  function status(): { gestureError: string | null; listening: boolean } {
    return { gestureError: listenerError, listening: Boolean(listener?.listening) }
  }

  return { applySettings, stop, status }
}

export type GestureController = ReturnType<typeof createGestureController>
