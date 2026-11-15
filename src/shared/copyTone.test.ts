/**
 * The product speaks to the user as «ты».
 *
 * This is not a style preference that can live in a document nobody reads at
 * the moment of writing a string: the app says it in the card, in settings, in
 * permission hints and in spoken lines, and a single «вы» — or a «пожалуйста»
 * — in the middle of that is the kind of thing that only shows up on screen. So
 * the rule from `AGENTS.md` ("Copy and tone") is checked here.
 *
 * Comments are skipped on purpose: a comment may quote a polite form to explain
 * why it is wrong, and it never reaches the person using the app. Text the model
 * reads is English and is out of scope by construction.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..', '..')

/** Files that may contain a polite form, and why. */
const ALLOWED: Record<string, string> = {
  // The verb stems are regex fragments matched against what the user typed, and
  // one of them spells out «нажмите» as an example of what it covers.
  'src/shared/intent.ts': 'verb stems matched against user input, not shown to anyone',
  'src/shared/intent.test.ts': 'the same stems, as inputs the router must recognise',
  // The patterns below are the polite forms themselves.
  'src/shared/copyTone.test.ts': 'the check itself'
}

/** The polite pronouns, matched as whole words so «выбор» and «выделение» do not trip. */
const POLITE_PRONOUN =
  /(?<![\p{L}])(?:вы|вас|вам|ваш|ваша|ваше|ваши|вашего|вашей|вашу|вашим|вашими|ваших)(?![\p{L}])/iu

/** The polite imperative forms, which carry no pronoun at all. */
const POLITE_IMPERATIVE =
  /(?<![\p{L}])(?:проверьте|введите|попробуйте|нажмите|выберите|увеличьте|укажите|откройте|разрешите|включите|выключите|удерживайте|добавьте|заполните|выполните|пересоберите|повторите|уточните|задайте|подождите|перезапустите|дождитесь|смотрите|говорите|возьмите|используйте|настройте|сохраните|удалите|перейдите|запустите)(?![\p{L}])/iu

/**
 * The politeness words that carry no request of their own.
 *
 * «Повтори, пожалуйста» used to reach the voice bank: the request is already on
 * «ты», and the word only adds a bow. «Извините» is the same bow in front of an
 * apology, and neither belongs in copy that is already direct.
 */
const POLITE_FORMULA = /(?<![\p{L}])(?:пожалуйста|извините)(?![\p{L}])/iu

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

/** A line that is only a comment never reaches the screen. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function violations(): string[] {
  return sources(join(ROOT, 'src')).flatMap((path) => {
    const name = relative(ROOT, path)
    if (ALLOWED[name]) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        if (isComment(line)) return []
        const hit =
          POLITE_PRONOUN.exec(line) ?? POLITE_IMPERATIVE.exec(line) ?? POLITE_FORMULA.exec(line)
        return hit ? [`${name}:${index + 1}  ${hit[0]}  →  ${line.trim()}`] : []
      })
  })
}

describe('copy: the app addresses the user as «ты»', () => {
  it('has no polite «вы» in any string the user can read', () => {
    expect(violations()).toEqual([])
  })

  it('keeps the allowlist honest', () => {
    // An allowlist entry for a file that no longer contains a polite form is a
    // permission nobody needs, and the next reader would think it was.
    for (const [name, reason] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, name), 'utf8')
      const found =
        POLITE_PRONOUN.test(text) || POLITE_IMPERATIVE.test(text) || POLITE_FORMULA.test(text)
      expect(found, `${name} no longer needs its exemption (${reason})`).toBe(true)
    }
  })
})
