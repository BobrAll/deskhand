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
      tts: DEFAULT_SETTINGS.tts,
      savedModel: DEFAULT_SETTINGS.voice.model,
      savedTts: DEFAULT_SETTINGS.tts,
      onVoiceChange: noop,
      onTtsChange: noop
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

  it('waits for the readiness check before reporting whether recognition works', () => {
    const html = voice()
    expect(html).toContain('Проверяем…')
    expect(html).not.toContain('Не готово')
    expect(html).not.toContain('Всё на месте')
  })

  it('tells the three states of the agent switch apart', () => {
    const render = (enabled: boolean): string =>
      renderToStaticMarkup(
        createElement(AgentTab, {
          agent: { ...DEFAULT_SETTINGS.agent, enabled },
          onChange: noop,
          onEnabledChange: async () => ({ enabled: true, ready: true, reason: null })
        })
      )

    // Off: said plainly, and no grant button — the grant is a different question
    // from the mode, which is exactly what the panel used to leave unsaid.
    expect(render(false)).toContain('Режим выключен')
    expect(render(false)).not.toContain('Открыть доступ')
    // On, but the machine has not said whether it is ready yet: no claim either way.
    expect(render(true)).not.toContain('Права выданы')
  })

  it('keeps the address next to the key it belongs to', () => {
    const html = provider()
    const key = html.indexOf('Ключ API')
    const baseUrl = html.indexOf('Base URL')
    const extraBody = html.indexOf('Доп. параметры запроса')
    expect(key).toBeGreaterThan(-1)
    expect(baseUrl).toBeGreaterThan(key)
    expect(extraBody).toBeGreaterThan(baseUrl)
  })

  it('shows the bundled recognizer and keeps Whisper and import in a closed disclosure', () => {
    const html = voice()
    const alternatives = html.match(/<details class="disclosure"><summary>Другие модели распознавания<\/summary>.*?<\/details>/)?.[0]
    expect(alternatives).toContain('Модели Whisper')
    expect(alternatives).toContain('Импортировать модель Whisper')
    expect(alternatives).not.toContain('GigaAM')
    expect(html).toContain('GigaAM v3 · встроенная модель для русского языка.')
  })

  it('offers the bundled Ruslan voice and the remote engine', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTab, {
        voice: DEFAULT_SETTINGS.voice,
        tts: { ...DEFAULT_SETTINGS.tts, engine: 'piper' },
        savedModel: DEFAULT_SETTINGS.voice.model,
        savedTts: { ...DEFAULT_SETTINGS.tts, engine: 'piper' },
        onVoiceChange: noop,
        onTtsChange: noop
      })
    )
    expect(html).toContain('Piper · Руслан')
    expect(html).toContain('Руслан уже в приложении')
    expect(html).not.toContain('Голос Piper')
    expect(html).not.toContain('Указать файл .onnx')
    // The remote-only fields belong to the other engine and are not shown here.
    expect(html).not.toContain('Адрес сервиса')
  })

  it('survives an empty exclusion list instead of rendering nothing', () => {
    expect(privacy([])).toContain('Список пуст')
    expect(privacy(['com.example.app'])).toContain('com.example.app')
  })
})
