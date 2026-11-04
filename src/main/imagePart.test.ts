import { describe, expect, it } from 'vitest'

import { imagePart } from './imagePart'

/**
 * One extraction for three requests. The cases that matter are the ones the
 * callers used to handle by silently skipping the `parts.push`: a URL that is not
 * an image, and no screenshot at all.
 */

describe('imagePart: what counts as an image', () => {
  it('reads a png data URL', () => {
    expect(imagePart('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      type: 'image',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo='
    })
  })

  it('keeps the subtype as it is, so jpeg stays jpeg', () => {
    expect(imagePart('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      base64: '/9j/4AAQ'
    })
  })

  it('accepts the svg+xml subtype', () => {
    expect(imagePart('data:image/svg+xml;base64,PHN2Zz4=')?.mimeType).toBe('image/svg+xml')
  })

  it('matches the prefix case-insensitively, as the old regex did', () => {
    expect(imagePart('DATA:IMAGE/PNG;base64,AAAA')?.base64).toBe('AAAA')
  })

  it('keeps an empty payload as an empty string, not as null', () => {
    expect(imagePart('data:image/png;base64,')).toEqual({
      type: 'image',
      mimeType: 'image/png',
      base64: ''
    })
  })
})

describe('imagePart: what is not an image', () => {
  it('rejects a data URL that is not base64', () => {
    expect(imagePart('data:image/png,notbase64')).toBeNull()
  })

  it('rejects a non-image data URL', () => {
    expect(imagePart('data:text/plain;base64,aGVsbG8=')).toBeNull()
  })

  it('rejects an ordinary https URL', () => {
    expect(imagePart('https://example.com/shot.png')).toBeNull()
  })

  it('rejects an empty string and the absent cases', () => {
    expect(imagePart('')).toBeNull()
    expect(imagePart(null)).toBeNull()
    expect(imagePart(undefined)).toBeNull()
  })
})
