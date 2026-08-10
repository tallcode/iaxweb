// Simulate an AI-spot publish for BG5ATV through the real SpotStore.
import { connect } from '@nats-io/transport-node'
import { config as loadEnv } from 'dotenv'
import { SpotStore } from '../src/ai/spot-store.js'
import { loadConfig } from '../src/config.js'
import { createConnectionOptions } from '../src/nats-audio.js'

loadEnv({ quiet: true })
const config = loadConfig()

const store = new SpotStore({
  createConnection: () => connect(createConnectionOptions(config.nats)),
})

await store.record({
  at: new Date().toISOString(),
  callsign: 'BG5ATV',
  node: '1900',
  segmentId: 'simulated-segment',
})

const recent = await store.recent()
console.log('recent after record:', JSON.stringify(recent, null, 2))
await store.close()
