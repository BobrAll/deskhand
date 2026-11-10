/**
 * Whether the real agent binary will accept a run on this machine.
 *
 * The sidecar checks the Accessibility grant before it accepts one
 * (`Bridge.swift`, `guard permissions.accessibility`), so on a Mac without the
 * grant every integration test fails with an error event instead of a stream.
 * That is a fact about the machine, not a regression in the code, and a suite
 * that reports sixteen failures for it hides the one failure that matters.
 *
 * The probe sends a real `run` and reads the first event. A run that is refused
 * answers with `code: "accessibility"`; anything else means the grant is there
 * and the caller may proceed. A probe that cannot answer in time is treated as
 * "no", so the tests skip rather than fail on a slow machine.
 */

import { spawn } from 'node:child_process'

const PROBE_TIMEOUT_MS = 5_000

export function agentAcceptsRuns(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }
    })
    let settled = false
    let buffer = ''

    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(accepted)
    }

    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) continue
        let message: { event?: string; params?: { code?: string } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        // `ready` only says the binary started; the answer to the run is what
        // comes next. A line without an event is an RPC reply, not an event.
        if (!message.event || message.event === 'ready') continue
        // The refusal is the only event this cares about; every other answer
        // means the binary got past the grant and started working.
        finish(!(message.event === 'error' && message.params?.code === 'accessibility'))
      }
    })

    child.on('error', () => finish(false))

    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: 'run',
        params: {
          task: 'ping',
          // A provider that cannot be reached: the probe only needs the
          // permission check, which runs before the first model call.
          provider: {
            wire: 'openai',
            base_url: 'http://127.0.0.1:1',
            model: 'probe',
            api_key: 'probe',
            max_tokens: 8,
            temperature: 0
          },
          options: { max_steps: 1, verify_actions: false, verbose: false, timings: false }
        }
      }) + '\n'
    )
  })
}
