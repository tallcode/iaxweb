import { onBeforeUnmount, onMounted } from 'vue'

const PULL_DISTANCE_PX = 32
const WHEEL_BURST_GAP_MS = 120
const MAX_PRECISE_WHEEL_DELTA_PX = 40
const MIN_PRECISE_WHEEL_EVENTS = 3

export function usePageTopPull(onPull: () => void): void {
  let touchPull: { x: number, y: number, distance: number } | undefined
  let wheelPull: { lastEventAt: number, distance: number, events: number, checked: boolean } | undefined

  onMounted(() => {
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    window.addEventListener('touchend', clearTouchPull)
    window.addEventListener('touchcancel', clearTouchPull)
    window.addEventListener('wheel', handleWheel, { passive: true })
  })

  onBeforeUnmount(() => {
    window.removeEventListener('touchstart', handleTouchStart)
    window.removeEventListener('touchmove', handleTouchMove)
    window.removeEventListener('touchend', clearTouchPull)
    window.removeEventListener('touchcancel', clearTouchPull)
    window.removeEventListener('wheel', handleWheel)
  })

  function clearTouchPull(): void {
    touchPull = undefined
  }

  function handleTouchStart(event: TouchEvent): void {
    const touch = event.touches[0]
    touchPull = event.touches.length === 1 && touch
      ? { x: touch.clientX, y: touch.clientY, distance: 0 }
      : undefined
  }

  function handleTouchMove(event: TouchEvent): void {
    const touch = event.touches[0]
    if (!touchPull || event.touches.length !== 1 || !touch)
      return

    const deltaX = touch.clientX - touchPull.x
    const deltaY = touch.clientY - touchPull.y
    touchPull.x = touch.clientX
    touchPull.y = touch.clientY

    if (window.scrollY > 0 || deltaY <= Math.abs(deltaX)) {
      touchPull.distance = 0
      return
    }

    touchPull.distance += deltaY
    if (touchPull.distance >= PULL_DISTANCE_PX) {
      clearTouchPull()
      onPull()
    }
  }

  function handleWheel(event: WheelEvent): void {
    // Wheel events do not identify the device. Require a burst of small pixel deltas.
    const deltaMode = event.deltaMode
    const distance = -event.deltaY
    if (window.scrollY > 0 || event.ctrlKey || event.shiftKey || deltaMode !== WheelEvent.DOM_DELTA_PIXEL
      || distance <= Math.abs(event.deltaX) || distance > MAX_PRECISE_WHEEL_DELTA_PX) {
      wheelPull = undefined
      return
    }

    if (!wheelPull || event.timeStamp - wheelPull.lastEventAt > WHEEL_BURST_GAP_MS)
      wheelPull = { lastEventAt: event.timeStamp, distance: 0, events: 0, checked: false }

    wheelPull.lastEventAt = event.timeStamp
    if (wheelPull.checked)
      return

    wheelPull.distance += distance
    wheelPull.events++
    if (wheelPull.events >= MIN_PRECISE_WHEEL_EVENTS && wheelPull.distance >= PULL_DISTANCE_PX) {
      wheelPull.checked = true
      onPull()
    }
  }
}
