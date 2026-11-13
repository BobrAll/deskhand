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
import type { TtsSettings, VoiceSettings } from '@shared/types'
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
      onSaveKey: async () => true,
      onRemoveKey: async () => {}
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

function voice(
  answerVoice: VoiceSettings['answerVoice'] = DEFAULT_SETTINGS.voice.answerVoice,
  tts: TtsSettings = DEFAULT_SETTINGS.tts
): string {
  const settings = { ...DEFAULT_SETTINGS.voice, answerVoice }
  return renderToStaticMarkup(
    createElement(VoiceTab, {
      voice: settings,
      tts,
      savedVoice: settings,
      savedTts: tts,
      microphoneGranted: true,
      onOpenMicrophoneSettings: noop,
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
      expect(html).toMatch(/class="pane(?: |")/)
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
    expect(voice()).toContain('Запись и команды')
    expect(voice()).toContain('Ответы вслух')
    expect(privacy()).toContain('Исключённые приложения')
  })

  it('shows revoke actions for granted permissions and keeps command memory under local data', () => {
    const html = privacy()
    expect(html).toMatch(/<nav[^>]*aria-label="Настройки приватности"><button[^>]*aria-pressed="true"[^>]*>Разрешения<\/button><button[^>]*>Данные на Mac<\/button><button[^>]*>Исключения<\/button>/)
    expect(html).toContain('aria-label="Отозвать в macOS · Универсальный доступ"')
    expect(html).toContain('aria-label="Отозвать в macOS · Микрофон"')
    expect(html).toContain('aria-label="Системные настройки · Запись экрана"')
    expect(html).toMatch(/-data" hidden=""><section[^>]*>.*Помнить предыдущую команду/)
  })

  it('offers a microphone check before the recording settings', () => {
    const html = voice()
    expect(html).toMatch(/Проверить микрофон.*Запись и команды/s)
    expect(html).toContain('Скажи пару слов, чтобы проверить сигнал.')
    expect(html).not.toContain('Микрофон работает')
  })

  it('starts the agent on screen settings and keeps the step limit after the switches', () => {
    const html = agent()
    expect(html).toMatch(/<nav[^>]*aria-label="Настройки агента"><button[^>]*aria-pressed="true"[^>]*>На экране<\/button><button[^>]*>Границы задачи<\/button><button[^>]*>Разрешения<\/button>/)
    expect(html).toMatch(/Останавливать при движении мыши.*Проверять результат по экрану.*Лимит шагов задачи/)
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
    expect(html).toContain('<details class="disclosure"><summary>Base URL</summary>')
    expect(html).not.toContain('https://platform.openai.com/api-keys')
    expect(extraBody).toBeGreaterThan(baseUrl)
  })

  it('keeps recognition model management behind one disclosure', () => {
    const html = voice()
    const management = html.match(/<details class="disclosure"><summary>Управление моделями<\/summary>.*?<\/details>/)?.[0]
    expect(management).toContain('Скачать модель Whisper')
    expect(management).toContain('Импортировать модель Whisper')
    expect(management?.match(/<details/g)).toHaveLength(1)
    expect(html).toContain('Распознавание речи')
    expect(html).not.toContain('Дополнительные настройки ввода')
  })

  it.each(['silero', 'remote'] as const)('shows only the macOS preview with a saved %s engine', (engine) => {
    const html = voice('system', { ...DEFAULT_SETTINGS.tts, engine, enabled: true })
    expect(html).toContain('Короткий пример голосом macOS.')
    expect(html).toContain('<button>Послушать пример</button>')
    expect(html).not.toContain('Голос Silero')
    expect(html).not.toContain('xenia')
    expect(html).not.toContain('Адрес API')
    expect(html).not.toContain('Ключ API')
    expect(html).not.toContain('Дополнительные настройки озвучки')
  })

  it('keeps the work feedback switch when automatic reading is off', () => {
    const html = voice('off')
    expect(html).toContain('Озвучивать ход работы')
    expect(html).not.toContain('Послушать пример')
    expect(html).not.toContain('Голос Silero')
    expect(html).not.toContain('Ключ API')
  })

  it('checks whether Silero is installed before offering a download or a voice', () => {
    const html = voice('neural', { ...DEFAULT_SETTINGS.tts, engine: 'silero', enabled: true })
    expect(html).toContain('Проверяю установку…')
    expect(html).toContain('CC BY-NC-SA 4.0')
    expect(html).toContain('<button disabled="">Послушать пример</button>')
    expect(html).not.toContain('Голос Silero')
    expect(html).not.toContain('>Скачать модель</button>')
    expect(html).not.toContain('Адрес API')
  })

  it('shows only the API connection fields with optional style in one disclosure', () => {
    const html = voice('neural', { ...DEFAULT_SETTINGS.tts, engine: 'remote', enabled: true })
    expect(html).toContain('Адрес API')
    expect(html).toContain('Ключ API')
    expect(html).toContain('<details class="disclosure"><summary>Стиль речи</summary>')
    expect(html).toContain('<button disabled="">Послушать пример</button>')
    expect(html).not.toContain('Голос Silero')
    expect(html).not.toContain('>Скачать модель</button>')
  })

  it('survives an empty exclusion list instead of rendering nothing', () => {
    expect(privacy([])).toContain('Список пуст')
    expect(privacy(['com.example.app'])).toContain('com.example.app')
  })
})
