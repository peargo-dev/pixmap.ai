// Web Audio UI sounds (ported from legacy Redux middleware)

const AudioContext = window.AudioContext || window.webkitAudioContext
let context = AudioContext ? new AudioContext() : null
let lastCooldownEndSound = 0

function isSoundEnabled() {
  return localStorage.getItem('pixmap:sound') !== 'false'
}

export function resumeSoundContext() {
  if (context?.state === 'suspended') {
    context.resume().catch(() => {})
  }
}

function playIfEnabled(fn) {
  if (!isSoundEnabled() || !context) return
  resumeSoundContext()
  fn(context)
}

export function playSelectColor() {
  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.detune.value = -600
    oscillatorNode.frequency.setValueAtTime(600, currentTime)
    oscillatorNode.frequency.setValueAtTime(700, currentTime + 0.1)

    gainNode.gain.setValueAtTime(0.3, currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.2, currentTime + 0.1)

    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillatorNode.start()
    oscillatorNode.stop(currentTime + 0.2)
  })
}

export function playNotification() {
  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.detune.value = -1200
    oscillatorNode.frequency.setValueAtTime(500, currentTime)
    oscillatorNode.frequency.setValueAtTime(600, currentTime + 0.1)

    gainNode.gain.setValueAtTime(0.3, currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.2, currentTime + 0.1)

    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillatorNode.start()
    oscillatorNode.stop(currentTime + 0.2)
  })
}

export function playAlert(alertType = 'default') {
  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    if (alertType === 'captcha') {
      oscillatorNode.type = 'sine'
      oscillatorNode.detune.value = -600
      oscillatorNode.start(currentTime)
      oscillatorNode.frequency.setValueAtTime(1479.98, currentTime)
      oscillatorNode.frequency.exponentialRampToValueAtTime(493.88, currentTime + 0.01)
      oscillatorNode.stop(currentTime + 0.1)
      gainNode.gain.setValueAtTime(0.5, currentTime)
      gainNode.gain.setTargetAtTime(0, currentTime, 0.1)
      oscillatorNode.connect(gainNode)
      gainNode.connect(ctx.destination)
      return
    }

    oscillatorNode.type = 'sine'
    oscillatorNode.detune.value = -900
    oscillatorNode.start(currentTime)
    oscillatorNode.frequency.setValueAtTime(600, currentTime)
    oscillatorNode.frequency.setValueAtTime(1400, currentTime + 0.025)
    oscillatorNode.frequency.setValueAtTime(1200, currentTime + 0.05)
    oscillatorNode.frequency.setValueAtTime(900, currentTime + 0.075)
    oscillatorNode.stop(currentTime + 0.3)

    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.start(currentTime)
    lfo.frequency.setValueAtTime(2.0, currentTime)
    lfo.stop(currentTime + 0.3)
    lfo.connect(gainNode)

    gainNode.gain.setValueAtTime(1.0, currentTime)
    gainNode.gain.setTargetAtTime(0, currentTime, 3)
    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
  })
}

export function playStackUsedUp() {
  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.start(currentTime)
    oscillatorNode.frequency.setValueAtTime(1479.98, currentTime)
    oscillatorNode.frequency.exponentialRampToValueAtTime(493.88, currentTime + 0.01)
    oscillatorNode.stop(currentTime + 0.1)
    gainNode.gain.setValueAtTime(0.5, currentTime)
    gainNode.gain.setTargetAtTime(0, currentTime, 0.1)
    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
  })
}

export function playPixelPlaced(colorIndex, colorsAmount) {
  playIfEnabled(ctx => {
    const amount = Math.max(1, colorsAmount || 1)
    const color = Math.max(0, colorIndex ?? 0)
    const clrFreq = 100 + Math.log(color / amount + 1) * 300

    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.start(currentTime)
    oscillatorNode.frequency.setValueAtTime(clrFreq, currentTime)
    oscillatorNode.frequency.exponentialRampToValueAtTime(1400, currentTime + 0.2)
    oscillatorNode.stop(currentTime + 0.1)
    gainNode.gain.setValueAtTime(0.5, currentTime)
    gainNode.gain.setTargetAtTime(0, currentTime, 0.1)
    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
  })
}

export function playCooldownEnd() {
  const now = Date.now()
  if (now - lastCooldownEndSound < 5000) return
  lastCooldownEndSound = now

  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.frequency.setValueAtTime(349.23, currentTime)
    oscillatorNode.frequency.setValueAtTime(523.25, currentTime + 0.1)
    oscillatorNode.frequency.setValueAtTime(698.46, currentTime + 0.2)

    gainNode.gain.setValueAtTime(0.5, currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.2, currentTime + 0.15)

    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillatorNode.start()
    oscillatorNode.stop(currentTime + 0.3)
  })
}

export function playChatMessage({ isPing = false } = {}) {
    return // disable for now
  playIfEnabled(ctx => {
    const oscillatorNode = ctx.createOscillator()
    const gainNode = ctx.createGain()
    const { currentTime } = ctx

    oscillatorNode.type = 'sine'
    oscillatorNode.frequency.setValueAtTime(310, currentTime)
    const freq = isPing ? 540 : 355
    oscillatorNode.frequency.exponentialRampToValueAtTime(freq, currentTime + 0.025)

    gainNode.gain.setValueAtTime(0.1, currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.1, currentTime + 0.1)

    oscillatorNode.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillatorNode.start()
    oscillatorNode.stop(currentTime + 0.075)
  })
}
