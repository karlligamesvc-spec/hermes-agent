// hc-1131: a request body can reach the mock in chunks split inside a Chinese character. Decoding each chunk on
// its own turned that character into replacement marks now and then, which failed a byte-for-byte comparison of
// system prompts with nothing wrong in the product.

import net from 'node:net'

import { afterEach, expect, it } from 'vitest'

import { receivedSystemPrompts, startMockServer } from './mock-server'

const closers: (() => Promise<unknown>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

/** POST `body` in two TCP writes, cut at `cut` bytes, and wait for the response to finish. */
async function postInTwoWrites(url: string, body: Buffer, cut: number): Promise<void> {
  const { hostname, pathname, port } = new URL(`${url}/v1/chat/completions`)

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, async () => {
      socket.write(
        `POST ${pathname} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`
      )
      socket.write(body.subarray(0, cut))
      await new Promise(done => setTimeout(done, 50))
      socket.write(body.subarray(cut))
    })

    socket.on('data', () => {})
    socket.on('end', resolve)
    socket.on('error', reject)
  })
}

it('keeps a character that arrives split across two chunks', async () => {
  const mock = await startMockServer({})

  closers.push(() => mock.close())

  const prompt = '信息够了再开工'
  const body = Buffer.from(
    JSON.stringify({ messages: [{ content: prompt, role: 'system' }, { content: 'hi', role: 'user' }], model: 'm' })
  )

  // One byte into 了 (three bytes in UTF-8).
  const cut = body.indexOf(Buffer.from('了')) + 1

  expect(cut).toBeGreaterThan(0)
  await postInTwoWrites(mock.url, body, cut)

  expect(receivedSystemPrompts.at(-1)).toBe(prompt)
})
