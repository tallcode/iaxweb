// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopologyLayout } from '../src/services/topology-layout'

afterEach(() => vi.unstubAllGlobals())

describe('topology disposal', () => {
  it('cancels pending frames and prevents late updates from restarting the layout', () => {
    let frameId = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const clearRect = vi.fn()
    const context = { clearRect, setLineDash: vi.fn(), setTransform: vi.fn() }
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const layout = new TopologyLayout(document.createElement('main'), canvas, new Map(), false, () => false)
    const edges = [{ connected: true, source: '1900', target: '1901' }]
    layout.updateGraph(edges, 'initial')
    expect(frames.size).toBe(1)

    layout.dispose()
    const drawsAtDisposal = clearRect.mock.calls.length
    layout.ensureNode('1900', 0, 1)
    layout.updateGraph(edges, 'late update')
    layout.relayout()
    expect(frames.size).toBe(0)
    expect(clearRect).toHaveBeenCalledTimes(drawsAtDisposal)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
})
