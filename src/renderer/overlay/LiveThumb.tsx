/**
 * The context tag's live thumbnail.
 *
 * The tag re-captures its image every couple of seconds, so the `src` changes
 * under it. Swapping it straight onto an `<img>` blanks the thumbnail for a frame
 * each time (the new data URL is decoded after the old one is dropped), so the
 * next frame is preloaded and only then takes over.
 */

import { useEffect, useState } from 'react'

export function LiveThumb({ src }: { src: string }) {
  const [shown, setShown] = useState(src)
  const [incoming, setIncoming] = useState<string | null>(null)

  useEffect(() => {
    if (src === shown) {
      setIncoming(null)
      return
    }
    let cancelled = false
    const loader = new Image()
    loader.decoding = 'sync'
    loader.onload = () => {
      if (cancelled) return
      setShown(src)
      setIncoming(null)
    }
    loader.onerror = () => {
      if (!cancelled) setIncoming(null)
    }
    loader.src = src
    setIncoming(src)
    return () => {
      cancelled = true
    }
  }, [src, shown])

  return (
    <>
      <img className="thumb" src={shown} alt="Скриншот экрана" decoding="sync" />
      {incoming && <img className="thumb probe" src={incoming} alt="" aria-hidden />}
    </>
  )
}
