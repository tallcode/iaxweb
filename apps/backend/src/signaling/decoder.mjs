// SPDX-License-Identifier: GPL-2.0-only
// MDC deinterleaving, FEC and CRC and FleetSync CRC/ECC layouts adapted from
// Matthew Kaufman's GPLv2 encoder/decoder library.
// Copyright (c) 2005, 2010, 2011, 2012, 2013, 2014 Matthew Kaufman. All rights reserved.
// https://github.com/atmatthewat/mdc-encode-decode
// https://github.com/russinnes/fsync-mdc1200-decode
// BSS TLVs: https://github.com/Ylianst/HTCommander/blob/main/docs/BSS-Protocol.md
import { Buffer } from 'node:buffer'

// No callsign dictionary, ASR input or model is used for decoding.
function crc16(bytes, initial = 0xFFFF) {
  let c = initial
  for (const v of bytes) {
    c ^= v
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0x8408 : 0)
  }
  return c
}
function unstuff(bits) {
  let ones = 0
  let n = 0
  let byte = 0
  const out = []
  for (const b of bits) {
    if (ones === 5) {
      if (b !== '0')
        return null
      ones = 0
      continue
    }
    const v = b === '1' ? 1 : 0
    byte |= v << (n % 8)
    n++
    ones = v ? ones + 1 : 0
    if (n % 8 === 0) {
      out.push(byte)
      byte = 0
    }
  }
  return n % 8 ? null : Buffer.from(out)
}
function parseFrame(frame) {
  if (frame.length < 4 || crc16(frame) !== 0xF0B8)
    return null
  const payload = frame.subarray(0, -2)
  const hex = frame.toString('hex')
  if (payload[0] === 1) {
    // These N76 frames have an undocumented extension before the TLVs.
    // Preserve it; require an unambiguous complete documented TLV suffix.
    const candidates = []
    for (let offset = 1; offset < payload.length - 2; offset++) {
      const fields = []
      let p = offset
      let source = null
      while (p < payload.length) {
        const n = payload[p]
        if (n < 1 || p + n + 1 > payload.length)
          break
        const type = payload[p + 1]
        const v = payload.subarray(p + 2, p + n + 1)
        if (type === 0x20 && v.length && v.every(c => c >= 32 && c < 127))
          source = v.toString('ascii')
        fields.push({ type, hex: v.toString('hex') })
        p += n + 1
      }
      if (p === payload.length && source) {
        candidates.push({
          sourceCallsign: source,
          fields,
          opaqueExtensionHex: payload.subarray(1, offset).toString('hex'),
        })
      }
    }
    if (candidates.length === 1)
      return { protocol: 'BSS', crcValid: true, fullFrameHex: hex, ...candidates[0] }
  }
  // AX.25 UI frame: shifted 6-character addresses, SSID/end bits, 03 F0.
  const addresses = []
  let p = 0
  while (p + 7 <= payload.length && addresses.length < 10) {
    const a = payload.subarray(p, p + 7)
    if (
      a.subarray(0, 6).some(v => v & 1 || !/[A-Z0-9 ]/.test(String.fromCharCode(v >>> 1)))
      || (a[6] & 0x60) !== 0x60
    ) {
      break
    }
    const ssid = (a[6] >>> 1) & 15
    const call = Array.from(a.subarray(0, 6), v => String.fromCharCode(v >>> 1))
      .join('')
      .trim()
    if (!call)
      break
    addresses.push(call + (ssid ? `-${ssid}` : ''))
    p += 7
    if (a[6] & 1) {
      if (addresses.length >= 2 && payload[p] === 3 && payload[p + 1] === 0xF0) {
        return {
          protocol: 'AX25/APRS',
          crcValid: true,
          fullFrameHex: hex,
          destination: addresses[0],
          sourceCallsign: addresses[1],
          path: addresses.slice(2),
          information: payload.subarray(p + 2).toString('utf8'),
        }
      }
      break
    }
  }
  return null
}
function basis(f, baud, n = 20) {
  const c = Float64Array.from({ length: n }, (_, j) => Math.cos((2 * Math.PI * f * (j + 0.5)) / n / baud))
  const s = Float64Array.from({ length: n }, (_, j) => Math.sin((2 * Math.PI * f * (j + 0.5)) / n / baud))
  const cn = Math.hypot(...c)
  for (let j = 0; j < n; j++) c[j] /= cn
  let dot = 0
  for (let j = 0; j < n; j++) dot += s[j] * c[j]
  for (let j = 0; j < n; j++) s[j] -= dot * c[j]
  const sn = Math.hypot(...s)
  for (let j = 0; j < n; j++) s[j] /= sn
  return [c, s]
}
function energies(x, rate, baud, phase, f0 = 1200, f1 = 2200) {
  const a = basis(f0, baud)
  const b = basis(f1, baud)
  const n = Math.floor((x.length / rate) * baud) - 2
  const e0 = new Float64Array(Math.max(0, n))
  const e1 = new Float64Array(Math.max(0, n))
  for (let k = 0; k < n; k++) {
    let ac = 0
    let as = 0
    let bc = 0
    let bs = 0
    for (let j = 0; j < 20; j++) {
      const t = ((k + phase + (j + 0.5) / 20) * rate) / baud
      const i = Math.floor(t)
      const v = x[i] + (x[i + 1] - x[i]) * (t - i)
      ac += v * a[0][j]
      as += v * a[1][j]
      bc += v * b[0][j]
      bs += v * b[1][j]
    }
    e0[k] = ac * ac + as * as
    e1[k] = bc * bc + bs * bs
  }
  return [e0, e1]
}
function decodeAfsk(audio, { tailSeconds = null, bauds = [1200, 1198, 1202], firstOnly = true } = {}) {
  const { samples, rate } = audio
  const start = tailSeconds === null ? 0 : Math.max(0, samples.length - Math.round(rate * tailSeconds))
  const x = samples.subarray(start)
  const found = new Map()
  let attempts = 0
  for (const baud of bauds) {
    for (let phaseIndex = 0; phaseIndex < 24; phaseIndex++) {
      const phase = phaseIndex / 24
      const [e0, e1] = energies(x, rate, baud, phase)
      for (const gain of [1, 1.5, 0.75, 2, 0.5]) {
        attempts++
        let prev = false
        let s = '0'
        for (let k = 0; k < e0.length; k++) {
          const tone = e1[k] * gain > e0[k]
          if (k)
            s += tone === prev ? '1' : '0'
          prev = tone
        }
        let a = s.indexOf('01111110')
        while (a >= 0) {
          const b = s.indexOf('01111110', a + 1)
          if (b < 0)
            break
          if (b - a >= 32 && b - a < 5000) {
            const packet = unstuff(s.slice(a + 8, b))
            const result = packet && parseFrame(packet)
            if (result) {
              found.set(result.fullFrameHex, {
                ...result,
                payloadStartSeconds: start / rate + (a + 8 + phase) / baud,
                baud,
                phase,
                gain,
              })
              if (firstOnly)
                return { matches: [...found.values()], attempts, scannedSeconds: x.length / rate }
            }
          }
          a = b
        }
      }
    }
  }
  return { matches: [...found.values()], attempts, scannedSeconds: x.length / rate }
}
function goertzel(x, start, n, rate, f) {
  const coeff = 2 * Math.cos((2 * Math.PI * f) / rate)
  let q1 = 0
  let q2 = 0
  for (let j = 0; j < n; j++) {
    const q = x[start + j] + coeff * q1 - q2
    q2 = q1
    q1 = q
  }
  return Math.max(0, q1 * q1 + q2 * q2 - coeff * q1 * q2)
}
function best(energies) {
  const indices = energies.map((_, i) => i).sort((a, b) => energies[b] - energies[a])
  return { index: indices[0], power: energies[indices[0]], runner: energies[indices[1]] }
}
function decodeTones(audio, protocol = 'DTMF') {
  const { samples: x, rate } = audio
  const n = Math.round(rate * 0.03)
  const hop = Math.round(rate * 0.01)
  const tokens = []
  const freqs = [697, 770, 852, 941, 1209, 1336, 1477, 1633]

  let last = null
  let run = 0
  let emitted = null
  for (let start = 0; start + n <= x.length; start += hop) {
    let energy = 0
    for (let j = 0; j < n; j++) energy += x[start + j] ** 2
    const es = freqs.map(f => goertzel(x, start, n, rate, f))
    let token = null
    if (energy / n > 1e-6) {
      const l = best(es.slice(0, 4))
      const h = best(es.slice(4))
      if (
        l.power > l.runner * 5
        && h.power > h.runner * 5
        && (l.power + h.power) / (n * energy) > 0.32
        && l.power / h.power > 0.15
        && l.power / h.power < 6.7
      ) {
        token = ['123A', '456B', '789C', '*0#D'][l.index][h.index]
      }
    }
    if (token === last) {
      run++
    }
    else {
      last = token
      run = 1
    }
    if (run >= 5 && token !== emitted) {
      if (token !== null)
        tokens.push({ symbol: token, time: start / rate })
      emitted = token
    }
  }
  return { protocol, sequence: tokens.map(t => t.symbol).join(''), tokens }
}
function fleetCrc(word1, word2) {
  let parity = 0
  let c = 0
  for (let i = 0; i < 48; i++) {
    const bit = i < 32 ? (word1 >>> (31 - i)) & 1 : (word2 >>> (63 - i)) & 1
    parity ^= bit
    const invert = bit ^ ((c >>> 15) & 1)
    if (invert)
      c ^= 0x6815
    c = (c << 1) & 0xFFFF
  }
  for (let i = 48; i < 63; i++) parity ^= (word2 >>> (63 - i)) & 1
  return ((c ^ 2) + parity) & 0xFFFF
}

function popcount(n) {
  n -= (n >>> 1) & 0x55555555
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24
}
function syncPositions(bits, sync, tolerance, inverted = false) {
  const low = Number.parseInt(sync.slice(-32), 2) >>> 0
  const high = Number.parseInt(sync.slice(0, -32) || '0', 2)
  const highBits = sync.length - 32
  const mask = (1 << highBits) - 1
  let hi = 0
  let lo = 0
  const positions = []
  for (let i = 0; i < bits.length; i++) {
    hi = ((hi << 1) | (lo >>> 31)) & mask
    lo = ((lo << 1) | (bits[i] === '1' ? 1 : 0)) >>> 0
    if (i < sync.length - 1)
      continue
    const errors = popcount(lo ^ low) + popcount(hi ^ high)
    if (errors <= tolerance)
      positions.push({ index: i + 1, inverse: false })
    else if (inverted && errors >= sync.length - tolerance)
      positions.push({ index: i + 1, inverse: true })
  }
  return positions
}
function repairMdc(data) {
  const shift = Array.from({ length: 7 }).fill(0)
  let syndrome = 0
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 8; j++) {
      for (let k = 6; k > 0; k--) shift[k] = shift[k - 1]
      shift[0] = (data[i] >>> j) & 1
      const parity = (shift[0] + shift[2] + shift[5] + shift[6]) & 1
      syndrome = (syndrome << 1) | (parity ^ ((data[i + 7] >>> j) & 1))
      if (popcount(syndrome & 0xA6) >= 3) {
        syndrome ^= 0xA6
        const bit = i * 8 + j - 7
        if (bit >= 0)
          data[bit >>> 3] ^= 1 << (bit & 7)
      }
    }
  }
}
function mdcWord(bits, index, inverse) {
  if (index + 112 > bits.length)
    return null
  const data = Buffer.alloc(14)
  let k = 0
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 7; j++, k++) {
      if ((bits[index + j * 16 + i] === '1') !== inverse)
        data[k >>> 3] |= 1 << (k & 7)
    }
  }
  if ((crc16(data.subarray(0, 4), 0) ^ 0xFFFF) !== data.readUInt16LE(4))
    repairMdc(data)
  return (crc16(data.subarray(0, 4), 0) ^ 0xFFFF) === data.readUInt16LE(4) ? data : null
}
function decodeMdcBits(bits) {
  const out = []
  for (const { index, inverse } of syncPositions(bits, '0000011100001001001010100100010001101111', 5, true)) {
    const data = mdcWord(bits, index, inverse)
    if (!data)
      continue
    // Extended messages require both independently valid CRCs.
    if ((data[0] === 0x35 || data[0] === 0x55) && !mdcWord(bits, index + 112, inverse))
      continue
    out.push({ protocol: 'MDC1200', unitHex: data.subarray(2, 4).toString('hex').toUpperCase(), rawHex: data.toString('hex') })
  }
  return out
}
const fleetChecks = [0x4045, 0x2067, 0x1076, 0x083B, 0x0458, 0x022C, 0x0116, 0x008B]
const fleetSyndromes = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x17, 0x2E, 0x5C, 0xB8, 0x67, 0xCE, 0x8B]
function repairFleet(value) {
  if (value & 0x8000)
    return null
  let syndrome = 0
  for (let i = 0; i < 8; i++) syndrome |= (popcount(value & fleetChecks[i]) & 1) << i
  if (syndrome === 0)
    return value
  const bit = fleetSyndromes.indexOf(syndrome)
  return bit < 0 ? null : value ^ (1 << (14 - bit))
}
function fleetWord(bits, start, encoded) {
  const length = encoded ? 256 : 64
  if (start + length > bits.length)
    return null
  let data = bits.slice(start, start + length)
  if (encoded) {
    let decoded = ''
    for (let block = 0; block < 4; block++) {
      for (const offset of [16, 0, 48, 32]) {
        const value = repairFleet(Number.parseInt(data.slice(block * 64 + offset, block * 64 + offset + 16), 2))
        if (value === null)
          return null
        decoded += ((value >>> 8) & 15).toString(2).padStart(4, '0')
      }
    }
    data = decoded
  }
  const w1 = Number.parseInt(data.slice(0, 32), 2) >>> 0
  const w2 = Number.parseInt(data.slice(32), 2) >>> 0
  if (fleetCrc(w1, w2) !== (w2 & 0xFFFF))
    return null
  const raw = Buffer.alloc(8)
  raw.writeUInt32BE(w1)
  raw.writeUInt32BE(w2, 4)
  return raw
}
function decodeFleetBits(bits) {
  const out = []
  for (const sync of ['10101010101010100010001111101011', '10101010101010100000010100101011']) {
    for (const { index } of syncPositions(bits, sync, 2)) {
      const raw = fleetWord(bits, index, false) ?? fleetWord(bits, index, true)
      if (!raw)
        continue
      const fleet = raw[2] + 99
      const unit = (raw[3] << 4) + (raw[4] >>> 4) + 999
      if (fleet < 100 || unit < 1000)
        continue
      out.push({ protocol: 'FleetSync', fromFleet: fleet, fromUnit: unit, rawHex: raw.toString('hex') })
    }
  }
  return out
}
// Sample-clock four-point MSK discriminator used by the reference MDC modem.
// This avoids losing weak packets that a one-symbol energy classifier misses.
function decodeMdcAudio(audio) {
  const found = new Map()
  const increment = Math.floor((1200 * 4294967296) / audio.rate)
  for (let channel = 0; channel < 5; channel++) {
    let phase = channel * 858993458
    let step = channel
    let bits = ''
    const level = new Float64Array(10)
    for (const sample of audio.samples) {
      const previous = phase
      phase = (phase + 5 * increment) >>> 0
      if (phase >= previous)
        continue
      step = (step + 1) % 10
      level[step] = sample
      if (step !== 3 && step !== 8)
        continue
      const current = step === 3 ? -0.6 * level[3] + 0.97 * level[1] : -0.6 * level[8] + 0.97 * level[6]
      const past = step === 3 ? -0.6 * level[7] + 0.97 * level[9] : -0.6 * level[2] + 0.97 * level[4]
      bits += current > past ? '1' : '0'
    }
    for (const frame of decodeMdcBits(bits)) found.set(frame.rawHex, frame)
  }
  return { matches: [...found.values()] }
}
function decodeFleetAudio(audio) {
  const found = new Map()
  for (const baud of [1200, 1198, 1202, 2400, 2396, 2404]) {
    for (let phase = 0; phase < 24; phase++) {
      const [e0, e1] = energies(audio.samples, audio.rate, baud, phase / 24, 1200, baud > 2000 ? 2400 : 1800)
      for (const gain of [1, 0.75, 1.5, 0.5, 2]) {
        let bits = ''
        for (let k = 0; k < e0.length; k++) bits += e1[k] * gain > e0[k] ? '0' : '1'
        for (const frame of decodeFleetBits(bits)) found.set(frame.rawHex, frame)
      }
    }
  }
  return { matches: [...found.values()] }
}

export function signalingWindows(pcm) {
  // One owned buffer, contiguous overlapping views. A signal need not be at
  // the end of the file (several real recordings contain a burst mid-record).
  // Five-second overlap also preserves the longest accepted HDLC frames.
  const owned = pcm.slice()
  const windows = []
  for (let start = 0; start < owned.length; start += 8000 * 5) {
    windows.push(owned.subarray(start, Math.min(start + 8000 * 10, owned.length)))
    if (start + 8000 * 10 >= owned.length)
      break
  }
  return windows
}

export function decodeSignaling(windows) {
  const signals = new Map()
  const add = (type, content) => {
    if (signals.size < 16)
      signals.set(`${type}:${content}`, { type, content })
  }
  for (const pcm of windows) {
    const audio = { samples: Float64Array.from(pcm, x => x / 32768), rate: 8000 }
    for (const frame of decodeAfsk(audio, { firstOnly: false }).matches) {
      if (frame.protocol === 'BSS')
        add('BSS', frame.sourceCallsign)
      else if (frame.protocol === 'AX25/APRS')
        add('APRS', frame.sourceCallsign)
    }
    for (const frame of decodeMdcAudio(audio).matches) add('MDC1200', `ID 0x${frame.unitHex}`)
    for (const frame of decodeFleetAudio(audio).matches)
      add('FleetSync', `${frame.fromFleet}-${frame.fromUnit}`)
    const tokens = decodeTones(audio).tokens
    let group = []
    const flush = () => {
      // With no checksum, an isolated speech-like tone is not an identifier.
      if (group.length >= 2)
        add('DTMF', group.map(t => t.symbol).join(''))
      group = []
    }
    for (const token of tokens) {
      if (group.length && token.time - group.at(-1).time > 0.3)
        flush()
      group.push(token)
    }
    flush()
  }
  return [...signals.values()]
}
