import { Meter, Player } from './audio-player.js'

const button = document.querySelector('#play')
const meter = new Meter(document)
const player = new Player(button, meter)

button.addEventListener('click', () => {
  if (player.context)
    void player.stop()
  else
    void player.start().catch(() => player.stop())
})
