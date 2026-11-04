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

export async function readPermissions(): Promise<PermissionState> {
  let accessibility = false
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    accessibility = false
  }

  let screenRecording = false
  try {
    screenRecording = systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    screenRecording = false
  }

  let microphone = false
  try {
    // `unknown` means the microphone was never touched; only `granted` counts,
    // because push-to-talk would otherwise fail on the first key press.
    microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  } catch {
    microphone = false
  }

  if (!accessibility) {
    const fallback = await helperPermissions(false).catch(() => null)
    if (fallback?.accessibility) accessibility = true
  }

  return { accessibility, screenRecording, microphone }
}

/**
 * Microphone access, asked for separately from the other two: a user who only
 * wants typed questions must not be shown a microphone prompt on first launch.
 */
export async function readMicrophonePermission(): Promise<boolean> {
  try {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  } catch {
    return false
  }
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

export function openPermissionPane(kind: 'accessibility' | 'screenRecording' | 'microphone'): void {
  if (kind === 'microphone') {
    openMicrophonePane()
    return
  }
  void shell.openExternal(kind === 'accessibility' ? ACCESSIBILITY_PANE : SCREEN_PANE)
}