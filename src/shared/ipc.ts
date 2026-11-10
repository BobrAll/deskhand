/**
 * IPC channel names shared by the main process and the preload bridge.
 * Keep this module free of Node/Electron imports.
 */

export const CH = {
  overlay: {
    getState: 'overlay:get-state',
    /** main -> renderer: a fresh OverlayState (new session started). */
    state: 'overlay:state',
    /**
     * main -> renderer: the card is on screen but the session does not exist yet.
     *
     * The window is shown before the context is collected, and the renderer is a
     * long-lived page that still holds the *previous* session — so without this
     * signal a reopened card would show the last answer for the few hundred
     * milliseconds it takes to read the selection, which reads as "it answered
     * before I asked".
     */
    preparing: 'overlay:preparing',
    /** main -> renderer: the collected context changed mid-session. */
    contextUpdate: 'overlay:context-update',
    /** main -> renderer: streaming events for the answer. */
    stream: 'overlay:stream',
    /** main -> renderer: how many shapes are drawn on the screen right now. */
    annotations: 'overlay:annotations',
    send: 'overlay:send',
    cancel: 'overlay:cancel',
    setFlags: 'overlay:set-flags',
    resize: 'overlay:resize',
    copy: 'overlay:copy',
    paste: 'overlay:paste',
    /** Removes the drawings from the screen without closing the card. */
    clearDrawing: 'overlay:clear-drawing',
    /**
     * renderer -> main: the user is writing in the card, so it has to come back
     * to its normal density — and its native blur — even while shapes are up.
     */
    typing: 'overlay:typing',
    close: 'overlay:close'
  },
  drawing: {
    /** main -> drawing layer: shapes to show (or to fade out). */
    draw: 'drawing:draw'
  },
  settings: {
    load: 'settings:load',
    save: 'settings:save',
    setKey: 'settings:set-key',
    deleteKey: 'settings:delete-key',
    testKey: 'settings:test-key',
    runningApps: 'settings:running-apps',
    pickApp: 'settings:pick-app',
    open: 'settings:open',
    close: 'settings:close',
    /**
     * "Edits are still in flight — keep the window alive."
     *
     * The window autosaves on a short debounce, so ⌘W can land between the
     * keystroke and the write. The renderer announces that before asking to
     * close, and the main process gives it a moment instead of destroying a
     * window whose last keystrokes have not been written yet.
     */
    hold: 'settings:hold',
    /**
     * "A hotkey is being recorded — stop listening for the old one."
     *
     * The app owns two global listeners (Electron's `globalShortcut` for the
     * card and the native tap for voice), and both fire on the combination the
     * user is trying to type into the recorder. Silencing them while the field
     * is armed is what makes re-assigning a shortcut possible at all.
     */
    recording: 'settings:recording'
  },
  permissions: {
    status: 'permissions:status',
    request: 'permissions:request',
    open: 'permissions:open',
    requestMicrophone: 'permissions:request-microphone'
  },
  onboarding: {
    complete: 'onboarding:complete',
    openSettings: 'onboarding:open-settings'
  },
  /**
   * Agent mode: the mouse and the keyboard belong to the assistant for the
   * duration of one run.
   *
   * The renderer only *reports* what it saw ("the run is on screen") and asks
   * to stop; every event that moves the cursor is posted by the main process
   * through the native helper, never by a page.
   */
  agent: {
    /** main -> renderer: the run changed phase, or moved to the next step. */
    event: 'agent:event',
    /** main -> agent display layer: what the run is doing and where to place the caption. */
    cursor: 'agent:cursor',
    /** main -> agent display layer: where the virtual pointer is going. */
    presentation: 'agent:presentation',
    /** overlay -> main: stop whatever is happening right now (Escape, «Стоп»). */
    stop: 'agent:stop',
    /**
     * overlay -> main: the user's answer to the question in the card.
     *
     * The agent blocks on this, so the channel is the whole safety mechanism: it
     * carries a decision about one named call, never a permission to act in
     * general, and the main process drops it if the id no longer matches the
     * question on screen.
     */
    answer: 'agent:answer',
    clearApprovals: 'agent:clear-approvals',
    /**
     * overlay -> main: may the assistant press and type right now, and if not,
     * which of the three reasons applies. Pulled by the settings tab and by the
     * card, because the answer changes when the user grants Accessibility and
     * nothing else announces that.
     */
    availability: 'agent:availability',
    /**
     * renderer -> main: turn the mode on or off, persisted immediately.
     *
     * The switch is one boolean with a real consequence, and leaving it in the
     * settings draft until the user finds "Сохранить" is how the mode ends up
     * looking broken: the checkbox is ticked, the assistant still only draws.
     * Both the settings tab and the card go through this, and it answers with the
     * new availability so the caller can name what is still missing (usually the
     * Accessibility grant) instead of assuming the switch was enough.
     */
    setEnabled: 'agent:set-enabled'
  },
  /** Push-to-talk: the keyboard tap in the main process drives the renderer. */
  voice: {
    /** main -> renderer: phase changed (listening / transcribing / idle). */
    event: 'voice:event',
    /** main -> renderer: start capturing from the microphone. */
    record: 'voice:record',
    /**
     * overlay -> main, on mount: which phase are we in, and may we record? The
     * first press *opens* the card, so the `record` broadcast can arrive before
     * the renderer is listening; the card pulls the state instead of losing it.
     */
    attach: 'voice:attach',
    /**
     * main -> overlay: recognised text. The renderer owns the request (busy state,
     * ids, context flags), so the transcript is delivered rather than "sent".
     */
    transcript: 'voice:transcript',
    /** main -> renderer: stop capturing; `transcribe` keeps the samples. */
    stop: 'voice:stop',
    /** renderer -> main: the finished WAV. */
    recorded: 'voice:recorded',
    /** renderer -> main: the recorder could not start (no permission, no device). */
    failed: 'voice:failed',
    /** renderer -> main: the level meter tick. */
    level: 'voice:level',
    /** Settings window: model list, install state, download progress. */
    status: 'voice:status',
    download: 'voice:download',
    downloadProgress: 'voice:download-progress',
    importModel: 'voice:import-model',
    deleteModel: 'voice:delete-model',
    test: 'voice:test'
  },
  /**
   * Speech synthesis for the assistant's own voice.
   *
   * Separate from `voice`, which is the microphone: this one only turns text
   * into a clip. The request is made by the main process because that is where
   * the provider key lives, and the clip comes back as base64 so the overlay can
   * play it without a second request.
   */
  tts: {
    /** overlay -> main: `{ ok, audio }` for one line, or a reason to use the system voice. */
    speak: 'tts:speak',
    /** Settings window: whether live synthesis is configured, and why not. */
    status: 'tts:status',
    /** Settings window: stores the synthesis key encrypted; never read back. */
    setKey: 'tts:set-key',
    deleteKey: 'tts:delete-key',
    /** Settings window: renders one short line so the voice can be heard. */
    preview: 'tts:preview'
  }
} as const
