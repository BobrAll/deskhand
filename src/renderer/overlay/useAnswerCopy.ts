import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

export function useAnswerCopy(answerTextRef: MutableRefObject<string>, onError: (message: string) => void) {
  /** The copy button says it worked, then goes back to being a command. */
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const resetCopied = useCallback(() => {
    setCopied(false)
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [])
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const copy = useCallback(async () => {
    const text = answerTextRef.current
    if (!text.trim()) return
    const result = await window.deskhand.overlay.copy(text)
    if (!result.ok) {
      resetCopied()
      onError(result.message ?? 'Не удалось скопировать ответ.')
      return
    }
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    setCopied(true)
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopied(false)
    }, 1500)
  }, [answerTextRef, onError, resetCopied])

  return { copied, resetCopied, copy }
}
