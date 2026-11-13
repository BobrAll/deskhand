import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecording } from '../overlay/recorder'
import { Group, Row } from './Row'

const MICROPHONE_LEVEL_BARS = 12

type MicrophoneTest =
  | { phase: 'idle' | 'starting' }
  | { phase: 'listening'; level: number }
  | { phase: 'finished'; heard: boolean }
  | { phase: 'error'; message: string }

export function MicrophoneCheck({
  visible, onOpenMicrophoneSettings
}: {
  visible: boolean
  onOpenMicrophoneSettings(): void
}) {
  const [test, setTest] = useState<MicrophoneTest>({ phase: 'idle' })
  const microphoneCheck = useRef<AbortController | null>(null)

  const cancelMicrophoneCheck = useCallback(() => {
    microphoneCheck.current?.abort()
    setTest({ phase: 'idle' })
  }, [])

  useEffect(() => {
    if (!visible) cancelMicrophoneCheck()
    return () => microphoneCheck.current?.abort()
  }, [visible, cancelMicrophoneCheck])

  async function checkMicrophone(): Promise<void> {
    if (microphoneCheck.current) return
    const controller = new AbortController()
    microphoneCheck.current = controller
    const { signal } = controller
    setTest({ phase: 'starting' })
    try {
      const recording = await startRecording(0)
      let peak = 0
      const sampleLevel = () => {
        const level = recording.level()
        peak = Math.max(peak, level)
        setTest({ phase: 'listening', level })
      }
      try {
        if (signal.aborted) return
        sampleLevel()
        await new Promise<void>((resolve) => {
          const meter = window.setInterval(sampleLevel, 80)
          const finish = () => {
            window.clearInterval(meter)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          signal.addEventListener('abort', finish, { once: true })
        })
      } finally {
        await recording.stop(false)
      }
      if (signal.reason === 'finished') setTest({ phase: 'finished', heard: peak >= 0.025 })
    } catch (error) {
      if (!signal.aborted) {
        const name = error instanceof Error ? error.name : ''
        const message = name === 'NotAllowedError'
          ? 'Разреши Deskhand доступ к микрофону в настройках macOS.'
          : name === 'NotFoundError'
            ? 'Микрофон не найден. Подключи его и попробуй ещё раз.'
            : 'Не удалось открыть микрофон. Проверь устройство ввода и попробуй ещё раз.'
        setTest({ phase: 'error', message })
      }
    } finally {
      if (microphoneCheck.current === controller) microphoneCheck.current = null
    }
  }

  const active = test.phase === 'starting' || test.phase === 'listening'
  let message = 'Скажи пару слов, чтобы проверить сигнал.'
  if (test.phase === 'starting') message = 'Подключаю микрофон…'
  if (test.phase === 'listening') message = 'Говори и смотри на полоски. Нажми «Остановить», когда закончишь.'
  if (test.phase === 'finished') {
    message = test.heard ? 'Микрофон работает. Сигнал есть.' : 'Сигнал слишком тихий. Подойди ближе и попробуй ещё раз.'
  }
  if (test.phase === 'error') message = test.message

  return (
    <Group title="Микрофон">
      <Row title="Проверка микрофона" hint={<span role="status">{message}</span>}>
        <button type="button" onClick={() => {
          if (test.phase === 'listening') microphoneCheck.current?.abort('finished')
          else if (active) cancelMicrophoneCheck()
          else void checkMicrophone()
        }}>
          {active ? 'Остановить' : 'Проверить микрофон'}
        </button>
      </Row>
      {test.phase === 'listening' && (
        <Row stacked>
          <div className="microphone-level" role="meter" aria-label="Уровень сигнала"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(test.level * 100)}>
            {Array.from({ length: MICROPHONE_LEVEL_BARS }, (_, index) => (
              <span key={index} data-lit={index < Math.ceil(test.level * MICROPHONE_LEVEL_BARS)} />
            ))}
          </div>
        </Row>
      )}
      {test.phase === 'error' && (
        <Row><button type="button" onClick={onOpenMicrophoneSettings}>Открыть «Приватность»</button></Row>
      )}
    </Group>
  )
}
