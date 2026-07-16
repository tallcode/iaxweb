import { AudioStreamPlayer, SpectrumMeter } from './audio-player.js'

const button = document.querySelector('#play')
const meter = new SpectrumMeter(document)
const player = new AudioStreamPlayer()

button.addEventListener('click', () => {
  void player.toggle('audio-page', button, meter).catch(() => player.stop())
})
