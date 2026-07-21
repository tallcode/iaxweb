import { AudioStreamPlayer, SpectrumMeter } from './audio-player.js'

const button = document.querySelector('#play')
const meter = new SpectrumMeter(document)
const player = new AudioStreamPlayer()
const nodeId = new URL(window.location.href).searchParams.get('node') || '1900'

button.addEventListener('click', () => {
  void player.toggle(nodeId, button, meter).catch(() => player.stop())
})
