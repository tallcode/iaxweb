// Publish a simulated AI spot for BG5ATV through the real Core NATS relay.
import { connect } from '@nats-io/transport-node'
import { config as loadEnv } from 'dotenv'
import { SpotStore } from '../src/ai/spot-store.js'
import { loadConfig } from '../src/config.js'
import { createConnectionOptions } from '../src/gateway/nats-audio.js'

loadEnv({ quiet: true })
const config = loadConfig()

const store = new SpotStore({
  createConnection: () => connect(createConnectionOptions(config.nats)),
})

await store.start(spot => console.log('received spot:', JSON.stringify(spot, null, 2)))
store.publish({
  at: new Date().toISOString(),
  callsign: 'BG5ATV',
  id: 'simulated-segment',
  node: '1900',
})
await new Promise(resolve => setTimeout(resolve, 100))
await store.close()
