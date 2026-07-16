import type { NodeDefinitions } from './types.js'

export function parseNodeDefinitions(value: unknown): NodeDefinitions {
  if (!isRecord(value))
    throw new Error('nodes.json must contain a JSON object')

  const definitions: NodeDefinitions = {}
  for (const [node, rawDefinition] of Object.entries(value)) {
    if (!/^\d+$/.test(node) || !isRecord(rawDefinition))
      throw new Error(`nodes.json contains an invalid node: ${node}`)
    const type = rawDefinition.TYPE
    if (type !== 'HUB' && type !== 'REPEATER')
      throw new Error(`nodes.json node ${node} must use TYPE HUB or REPEATER`)
    const link = rawDefinition.LINK
    if (link !== undefined && (!Array.isArray(link) || !link.every(target => typeof target === 'string' && /^\d+$/.test(target))))
      throw new Error(`nodes.json node ${node} has an invalid LINK list`)
    const freq = rawDefinition.FREQ
    if (freq !== undefined && typeof freq !== 'string')
      throw new Error(`nodes.json node ${node} has an invalid FREQ`)
    const name = rawDefinition.NAME
    if (name !== undefined && typeof name !== 'string')
      throw new Error(`nodes.json node ${node} has an invalid NAME`)
    const audio = rawDefinition.AUDIO
    if (audio !== undefined && typeof audio !== 'boolean')
      throw new Error(`nodes.json node ${node} has an invalid AUDIO`)

    definitions[node] = {
      TYPE: type,
      ...(audio !== undefined ? { AUDIO: audio } : {}),
      ...(link ? { LINK: [...link] } : {}),
      ...(freq ? { FREQ: freq } : {}),
      ...(name ? { NAME: name } : {}),
    }
  }
  return definitions
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
