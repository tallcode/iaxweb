import type { NodeConfig } from './types.js'

interface ConfigMergeResult {
  configs: Map<string, NodeConfig>
  retained: string[]
  unavailable: string[]
}

export function mergeNodeConfigs(
  nodes: string[],
  results: PromiseSettledResult<NodeConfig>[],
  previousConfigs: Map<string, NodeConfig>,
): ConfigMergeResult {
  const configs = new Map<string, NodeConfig>()
  const retained: string[] = []
  const unavailable: string[] = []

  for (const [index, node] of nodes.entries()) {
    const result = results[index]
    if (result?.status === 'fulfilled' && Number.isInteger(result.value.statport)) {
      configs.set(node, result.value)
      continue
    }

    const previous = previousConfigs.get(node)
    if (previous) {
      configs.set(node, previous)
      retained.push(node)
    }
    else {
      unavailable.push(node)
    }
  }

  return { configs, retained, unavailable }
}
