/**
 * Every pane renders without a DOM.
 *
 * There is no browser test runner in this repo, and the settings window is four
 * components that a person only notices when they are broken. Rendering to a
 * string catches the class of failure that a type check cannot: a prop renamed
 * on one side of a section, a hook that throws when the window mounts, a list
 * that maps over `undefined` because the bundle has not loaded yet.
 *
 * The assertions are structural on purpose — the words are allowed to change,
 * the shape is not: a pane is cards, a card is rows, a switch says whether it is
 * on.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { AgentTab } from './AgentTab'
import { VoiceTab } from './VoiceTab'
import { ProviderSection } from './sections/ProviderSection'
import { PrivacySection } from './sections/PrivacySection'

const noop = () => {}

function provider(): string {
  return renderToStaticMarkup(
    createElement(ProviderSection, {
      draft: DEFAULT_SETTINGS,
      patch: noop,
      providerKeys: { openrouter: undefined, openai: undefined, anthropic: undefined },
      invalidBaseUrls: [],
      keyInput: '',
      onKeyInput: noop,
      testing: false,
      onSaveKey: noop,
      onRemoveKey: noop
    })
  )
}

function agent(): string {
  return renderToStaticMarkup(
    createElement(AgentTab, {
      agent: DEFAULT_SETTINGS.agent,
      onChange: noop,
      onEnabledChange: async () => ({ enabled: true, ready: true, reason: null })
    })
  )
}

function voice(): string {
  return renderToStaticMarkup(
    createElement(VoiceTab, {
      voice: DEFAULT_SETTINGS.voice,
      savedModel: DEFAULT_SETTINGS.voice.model,
      onChange: noop
    })
  )
}

function privacy(excludedApps: string[] = []): string {
  return renderToStaticMarkup(
    createElement(PrivacySection, {
      draft: { ...DEFAULT_SETTINGS, excludedApps },
      patch: noop,
      permissions: { accessibility: true, screenRecording: false, microphone: true },
      encryptionAvailable: true,
      apps: [],
      setBundle: noop,
      onAddExcluded: noop
    })
  )
}

describe('the settings panes', () => {
  it('are built from cards and rows, not loose fields', () => {
    for (const html of [provider(), agent(), voice(), privacy()]) {
      expect(html).toContain('class="pane"')
      expect(html).toContain('class="group-body"')
      expect(html).toContain('class="row"')
    }
  })

  it('render every switch with a state a screen reader can read', () => {
    for (const html of [agent(), voice(), privacy(), provider()]) {
      const switches = html.match(/role="switch"/g) ?? []
      const states = html.match(/role="switch" aria-checked="(true|false)"/g) ?? []
      expect(states.length).toBe(switches.length)
      // The state comes before the label in the attribute order, and every switch
      // has one, so a switch that forgot `aria-checked` would show up as a count
      // mismatch rather than as a silent accessibility bug.
      expect(switches.length).toBeGreaterThan(0)
    }
  })

  it('names the cards the user is expected to find', () => {
    expect(provider()).toContain('Подключение')
    expect(provider()).toContain('Скриншот')
    expect(agent()).toContain('Границы')
    expect(voice()).toContain('Распознавание')
    expect(privacy()).toContain('Исключённые приложения')
  })

  it('survives an empty exclusion list instead of rendering nothing', () => {
    expect(privacy([])).toContain('Список пуст')
    expect(privacy(['com.example.app'])).toContain('com.example.app')
  })
})
