import { useId, useState } from 'react'
import type { TtsSettings, VoiceSettings } from '@shared/types'
import { VoiceInput } from './VoiceInput'
import { VoiceOutput } from './VoiceOutput'

interface VoiceTabProps {
  microphoneGranted: boolean
  onOpenMicrophoneSettings(): void
  voice: VoiceSettings
  tts: TtsSettings
  savedVoice: VoiceSettings
  savedTts: TtsSettings
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
}

export function VoiceTab({
  voice,
  tts,
  savedVoice,
  savedTts,
  microphoneGranted,
  onOpenMicrophoneSettings,
  onVoiceChange,
  onTtsChange
}: VoiceTabProps) {
  const [section, setSection] = useState<'input' | 'speech'>('input')
  const sectionId = useId()

  return (
    <div className="pane voice-pane">
      <nav className="segmented" aria-label="Раздел звука и голоса">
        {(['input', 'speech'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={section === item ? 'active' : undefined}
            aria-pressed={section === item}
            aria-controls={`${sectionId}-${item}`}
            onClick={() => setSection(item)}
          >
            {item === 'input' ? 'Ввод' : 'Озвучка'}
          </button>
        ))}
      </nav>
      <div className="voice-section" id={`${sectionId}-input`} hidden={section !== 'input'}>
        <VoiceInput
          active={section === 'input'}
          voice={voice}
          savedVoice={savedVoice}
          microphoneGranted={microphoneGranted}
          onOpenMicrophoneSettings={onOpenMicrophoneSettings}
          onVoiceChange={onVoiceChange}
        />
      </div>
      <div className="voice-section" id={`${sectionId}-speech`} hidden={section !== 'speech'}>
        <VoiceOutput
          active={section === 'speech'}
          voice={voice}
          tts={tts}
          savedTts={savedTts}
          onVoiceChange={onVoiceChange}
          onTtsChange={onTtsChange}
        />
      </div>
    </div>
  )
}
