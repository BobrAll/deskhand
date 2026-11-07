/** Parse the schemes accepted by browser navigation. */
export function parseWebUrl(raw: string): URL | null {
  const url = URL.canParse(raw) ? new URL(raw) : null
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username || url.password) return null
  return url
}

/** Resolve a web destination explicitly named in the current request. */
export function navigationUrl(raw: string, prompt: string): string | null {
  const url = parseWebUrl(raw)
  if (!url) return null

  const explicit = prompt.match(/https?:\/\/[^\s<>"«»]+/gi) ?? []
  if (explicit.some((entry) => {
    const clean = entry.replace(/[.,!?]+$/, '')
    return URL.canParse(clean) && new URL(clean).href === url.href
  })) return url.href

  // A bare domain authorizes opening its homepage. Paths and parameters must
  // come from an explicit URL so the model cannot attach unrelated data.
  if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash) return null
  const domains = prompt.toLowerCase().match(/(?<![\w.@/:])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w.@-])/g) ?? []
  return domains.some((domain) => domain.replace(/^www\./, '') === url.hostname.replace(/^www\./, ''))
    ? url.href : null
}
