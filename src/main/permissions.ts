/**
 * macOS TCC permission helpers.
 *
 * Electron can report both permissions we need, so that is the primary source of
 * truth: the helper binary inherits our TCC identity but its own answers are less
 * reliable, hence it is only used as a fallback.
 */

import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { PermissionState } from '@shared/types'
import { helperPermissions } from './native/helper'

const ACCESSIBILITY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const MICROPHONE_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/**
 * Reads one permission without letting a missing API take the whole report down.
 *
 * Older macOS builds answer some of these calls with an exception instead of a
 * status; the caller treats that as "not granted".
 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export async function readPermissions(): Promise<PermissionState> {
  let accessibility = safe(() => systemPreferences.isTrustedAccessibilityClient(false), false)
  const screenRecording = safe(
    () => systemPreferences.getMediaAccessStatus('screen') === 'granted',
    false
  )
  // `unknown` means the microphone was never touched; only `granted` counts,
  // because push-to-talk would otherwise fail on the first key press.
  const microphone = safe(
    () => systemPreferences.getMediaAccessStatus('microphone') === 'granted',
    false
  )

  if (!accessibility) {
    const fallback = await helperPermissions(false).catch(() => null)
    if (fallback?.accessibility) accessibility = true
  }

  return { accessibility, screenRecording, microphone }
}

/**
 * Asks for the microphone. `askForMediaAccess` is the only call that shows the
 * system prompt; it resolves with the answer, so the caller can react at once.
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    return false
  }
}

/**
 * Asks macOS for both permissions. The accessibility call shows the system
 * prompt once; screen recording has no direct request API in Electron, so we
 * touch the capturer which makes the system ask.
 */
export async function requestPermissions(): Promise<PermissionState> {
  try {
    // Passing `true` makes macOS show the "grant accessibility" prompt once.
    systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    /* not available on this macOS version */
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (status !== 'granted') {
      // Triggers the Screen Recording prompt on macOS 10.15+.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    }
  } catch {
    /* the user may simply have no screen */
  }

  await helperPermissions(true).catch(() => null)
  return readPermissions()
}

export function openMicrophonePane(): void {
  void shell.openExternal(MICROPHONE_PANE)
}

/** The System Settings panes the app can send the user to. */
export type PermissionPane = 'accessibility' | 'screenRecording' | 'microphone'

export function openPermissionPane(kind: PermissionPane): void {
  if (kind === 'microphone') {
    openMicrophonePane()
    return
  }
  void shell.openExternal(kind === 'accessibility' ? ACCESSIBILITY_PANE : SCREEN_PANE)
}
