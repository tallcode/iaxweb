import type { NodeDefinitions } from './types.js'

export function parseNodeDefinitions(value: unknown): NodeDefinitions {
  if (!isRecord(value))
    throw new Error('config/nodes.json must contain a JSON object')

  const definitions: NodeDefinitions = {}
  for (const [node, rawDefinition] of Object.entries(value)) {
    if (!/^\d+$/.test(node) || !isRecord(rawDefinition))
      throw new Error(`config/nodes.json contains an invalid node: ${node}`)
    const type = rawDefinition.TYPE
    if (type !== 'HUB' && type !== 'REPEATER')
      throw new Error(`config/nodes.json node ${node} must use TYPE HUB or REPEATER`)
    const link = rawDefinition.LINK
    if (link !== undefined && (!Array.isArray(link) || !link.every(target => typeof target === 'string' && /^\d+$/.test(target))))
      throw new Error(`config/nodes.json node ${node} has an invalid LINK list`)
    const freq = rawDefinition.FREQ
    if (freq !== undefined && typeof freq !== 'string')
      throw new Error(`config/nodes.json node ${node} has an invalid FREQ`)
    const gb = rawDefinition.GB
    if (gb !== undefined && (typeof gb !== 'string' || !/^156\d{6}$/.test(gb)))
      throw new Error(`config/nodes.json node ${node} has an invalid GB`)
    const name = rawDefinition.NAME
    if (name !== undefined && typeof name !== 'string')
      throw new Error(`config/nodes.json node ${node} has an invalid NAME`)
    const audio = rawDefinition.AUDIO
    if (audio !== undefined && typeof audio !== 'boolean')
      throw new Error(`config/nodes.json node ${node} has an invalid AUDIO`)
    const ai = rawDefinition.AI
    if (ai !== undefined && typeof ai !== 'boolean')
      throw new Error(`config/nodes.json node ${node} has an invalid AI`)
    if (ai === true && audio !== true)
      throw new Error(`config/nodes.json node ${node} must have AUDIO true to enable AI`)

    definitions[node] = {
      TYPE: type,
      ...(ai !== undefined ? { AI: ai } : {}),
      ...(audio !== undefined ? { AUDIO: audio } : {}),
      ...(link ? { LINK: [...link] } : {}),
      ...(freq ? { FREQ: freq } : {}),
      ...(gb ? { GB: gb } : {}),
      ...(name ? { NAME: name } : {}),
    }
  }
  return definitions
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
