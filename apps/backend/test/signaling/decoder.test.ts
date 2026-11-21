import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { decodeSignaling, signalingWindows } from '../../src/signaling/decoder.mjs'
import { SignalingService } from '../../src/signaling/service.js'

interface Fixture {
  name: string
  pcm: string
  expected: Array<{ type: string, content: string }>
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Fixture[]

// Checked-in waveforms come from independent reference encoders/modems, not
// callsign dictionaries or the production decoder's framing/CRC functions.
for (const fixture of fixtures) {
  test(`signaling reference waveform: ${fixture.name}`, () => {
    const data = inflateSync(Buffer.from(fixture.pcm, 'base64'))
    const pcm = Int16Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2))
    assert.deepEqual(decodeSignaling(signalingWindows(pcm)), fixture.expected)
  })
}

test('stopping the background decoder settles queued work without keeping the app alive', async () => {
  const service = new SignalingService()
  const jobs = Array.from({ length: 4 }, () => service.decode(new Int16Array(8_000)))
  service.stop()
  assert.deepEqual(await Promise.all(jobs), [null, null, null, null])
  assert.equal(await service.decode(new Int16Array(8_000)), null)
})
