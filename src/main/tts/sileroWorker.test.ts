/**
 * The warm Silero process, proved without Python or the weights.
 *
 * A fake child stands in for the interpreter: it records the JSON lines, answers
 * on stdout the way `worker_tts.py` does, and can exit or stay silent on demand.
 * The properties that matter are the ones a user feels — one model load for two
 * phrases, a stuck worker killed instead of hanging the card, and a fresh worker
 * after a crash — plus the one-shot fallback that keeps the voice audible.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { SileroWorker, type SileroWorkerChild, type SileroWorkerOptions } from './sileroWorker'

interface Request {
  id: number
  text: string
  output: string
}

class FakeChild extends EventEmitter {
  readonly requests: Request[] = []
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string): boolean => {
      const request = JSON.parse(chunk) as Request
      this.requests.push(request)
      this.onWrite?.(request, this)
      return true
    }
  })
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn((_signal?: NodeJS.Signals): boolean => true)
  onWrite: ((request: Request, child: FakeChild) => void) | null = null

  reply(payload: { id: number; ok: boolean; error?: string }): void {
    this.stdout.write(`DESKHAND ${JSON.stringify(payload)}\n`)
  }
}

function asChild(child: FakeChild): SileroWorkerChild {
  return child as unknown as SileroWorkerChild
}

function createWorker(
  spawnWorker: () => SileroWorkerChild,
  options: Partial<SileroWorkerOptions> = {}
): SileroWorker {
  return new SileroWorker({
    spawnWorker,
    requestTimeoutMs: 1000,
    idleTimeoutMs: 60_000,
    log: () => undefined,
    ...options
  })
}

function answeringChild(): FakeChild {
  const child = new FakeChild()
  child.onWrite = (request, target) => target.reply({ id: request.id, ok: true })
  return child
}

describe('the warm Silero worker', () => {
  it('spawns once and reuses the model for two phrases', async () => {
    const children: FakeChild[] = []
    const worker = createWorker(() => {
      const child = answeringChild()
      children.push(child)
      return asChild(child)
    })
    const fallback = vi.fn(async () => undefined)

    await worker.render('Первый.', '/tmp/one.wav', fallback)
    await worker.render('Второй.', '/tmp/two.wav', fallback)

    expect(children).toHaveLength(1)
    expect(children[0].requests.map((request) => request.text)).toEqual(['Первый.', 'Второй.'])
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()

    worker.stop()
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('turns a stdin error into a failed job instead of an unhandled stream error', async () => {
    const child = new FakeChild()
    // A real EPIPE arrives asynchronously; emitting it inside `write` would be
    // caught by the write's own try/catch even without the stream listener.
    child.onWrite = () => { queueMicrotask(() => child.stdin.emit('error', new Error('EPIPE'))) }
    const worker = createWorker(() => asChild(child))
    const fallback = vi.fn(async () => undefined)

    await worker.render('Фраза.', '/tmp/broken.wav', fallback)

    expect(fallback).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    worker.stop()
  })

  it('kills a worker that never answers and reports the failed request', async () => {
    const child = new FakeChild()
    const onTimeout = vi.fn()
    const worker = createWorker(() => asChild(child), { requestTimeoutMs: 20, onTimeout })
    const fallback = vi.fn(async () => {
      throw new Error('one-shot failed')
    })

    await expect(worker.render('Тишина.', '/tmp/silent.wav', fallback))
      .rejects.toThrow('one-shot failed')

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledOnce()
    worker.stop()
  })

  it('serializes two phrases without waiting for the first render', async () => {
    let firstId = 0
    const child = new FakeChild()
    child.onWrite = (request, target) => {
      if (request.text === 'Первый.') {
        firstId = request.id
        return
      }
      target.reply({ id: request.id, ok: true })
    }
    const worker = createWorker(() => asChild(child))

    const first = worker.render('Первый.', '/tmp/one.wav', vi.fn(async () => undefined))
    const second = worker.render('Второй.', '/tmp/two.wav', vi.fn(async () => undefined))

    await vi.waitFor(() => expect(child.requests).toHaveLength(1))
    expect(child.requests[0].text).toBe('Первый.')

    child.reply({ id: firstId, ok: true })
    await first
    await second

    expect(child.requests.map((request) => request.text)).toEqual(['Первый.', 'Второй.'])
    worker.stop()
  })

  it('checks the produced file inside the queue before the next phrase', async () => {
    const child = answeringChild()
    const worker = createWorker(() => asChild(child))
    const verify = vi.fn(async () => { throw new Error('empty output') })
    const fallback = vi.fn(async () => undefined)

    await worker.render('Пустой файл.', '/tmp/empty.wav', fallback, verify)

    expect(verify).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
    worker.stop()
  })

  it('rejects the pending phrase when the worker exits and respawns for the next', async () => {
    const children: FakeChild[] = []
    let first = true
    const worker = createWorker(() => {
      const child = new FakeChild()
      child.onWrite = (request, target) => {
        if (first) {
          first = false
          target.emit('exit', 1, null)
          return
        }
        target.reply({ id: request.id, ok: true })
      }
      children.push(child)
      return asChild(child)
    })
    const failed = vi.fn(async () => {
      throw new Error('one-shot failed')
    })

    await expect(worker.render('Первый.', '/tmp/one.wav', failed)).rejects.toThrow('one-shot failed')
    expect(children).toHaveLength(1)

    await worker.render('Второй.', '/tmp/two.wav', failed)

    expect(children).toHaveLength(2)
    expect(children[1].requests[0].text).toBe('Второй.')
    expect(failed).toHaveBeenCalledTimes(1)
    worker.stop()
  })

  it('falls back to the one-shot renderer when the worker cannot start', async () => {
    const worker = createWorker(() => {
      throw new Error('python is missing')
    })
    const fallback = vi.fn(async () => undefined)

    await worker.render('Строка.', '/tmp/line.wav', fallback)

    expect(fallback).toHaveBeenCalledTimes(1)
    worker.stop()
  })

  it('falls back when the worker answers with garbage', async () => {
    const child = new FakeChild()
    child.onWrite = (_request, target) => {
      target.stdout.write('DESKHAND not-json\n')
    }
    const worker = createWorker(() => asChild(child))
    const fallback = vi.fn(async () => undefined)

    await worker.render('Строка.', '/tmp/line.wav', fallback)

    expect(fallback).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    worker.stop()
  })

  it('ignores unrelated stdout from the library', async () => {
    const child = new FakeChild()
    child.onWrite = (request, target) => {
      target.stdout.write('loading model...\n')
      target.reply({ id: request.id, ok: true })
    }
    const worker = createWorker(() => asChild(child))
    const fallback = vi.fn(async () => undefined)

    await worker.render('Строка.', '/tmp/line.wav', fallback)

    expect(fallback).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    worker.stop()
  })
})
