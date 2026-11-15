import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'

export function useAnswerScroll(answer: string) {
  /** The answer has new text below the reader's position. */
  const [newText, setNewText] = useState(false)
  /** The reader asked to follow the bottom; a new answer starts at the top. */
  const followAnswerRef = useRef(false)
  /** A rewrite keeps the old answer mounted until its first chunk; jump then. */
  const scrollToTopOnNextAnswerRef = useRef(false)
  const answerRef = useRef<HTMLDivElement | null>(null)

  const stopFollowing = useCallback(() => {
    followAnswerRef.current = false
    setNewText(false)
  }, [])

  const resetScroll = useCallback(() => {
    stopFollowing()
    scrollToTopOnNextAnswerRef.current = false
  }, [stopFollowing])

  const prepareRewriteScroll = useCallback(() => {
    stopFollowing()
    // Keep the old answer in place until the rewrite's first chunk arrives.
    scrollToTopOnNextAnswerRef.current = true
  }, [stopFollowing])

  useEffect(() => {
    const node = answerRef.current
    if (!node) return
    if (scrollToTopOnNextAnswerRef.current) {
      scrollToTopOnNextAnswerRef.current = false
      node.scrollTop = 0
      followAnswerRef.current = false
    }
    if (followAnswerRef.current) {
      node.scrollTop = node.scrollHeight
      setNewText(false)
    } else {
      // The answer starts at its beginning; the pill appears only when there is
      // actually something below the fold — while streaming and after it ends.
      setNewText(node.scrollHeight > node.clientHeight + 1)
    }
  }, [answer])

  /**
   * Follow the stream only while the reader is at its bottom.
   *
   * Scrolling up is a request to read the beginning; the next token must not
   * undo it. The threshold leaves a few points for the last line's descenders.
   */
  const onAnswerScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    const hidden = node.scrollHeight > node.clientHeight + 1
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    followAnswerRef.current = atBottom
    setNewText(!atBottom && hidden)
  }, [])

  const jumpToNewText = useCallback(() => {
    const node = answerRef.current
    if (!node) return
    followAnswerRef.current = true
    node.scrollTop = node.scrollHeight
    setNewText(false)
  }, [])

  return { answerRef, newText, onAnswerScroll, jumpToNewText, stopFollowing, resetScroll, prepareRewriteScroll }
}
