// Minecraft 1.7.10 Forge bot
// Joins the server, completes the Forge (FML) handshake using the server's own
// mod list, stays online, and reconnects automatically if it gets disconnected.

const mc = require('minecraft-protocol')
const forge = require('minecraft-protocol-forge')

const HOST = process.env.MC_HOST
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const USERNAME = process.env.MC_USERNAME || 'ServerBot'
const VERSION = '1.7.10'
const RECONNECT_DELAY_MS = 15000

if (!HOST) {
  console.error('MC_HOST is not set. Add it as a GitHub secret.')
  process.exit(1)
}

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

function start () {
  log(`Pinging ${HOST}:${PORT} ...`)

  // Ping first so we can copy the server's mod list for the Forge handshake.
  mc.ping({ host: HOST, port: PORT, version: VERSION }, (err, result) => {
    if (err) {
      log('Ping failed:', err.message)
      return setTimeout(start, RECONNECT_DELAY_MS)
    }

    const modList = (result && result.modinfo && result.modinfo.modList) || []
    log(`Server reports ${modList.length} Forge mod(s):`,
      modList.map(m => `${m.modid}@${m.version}`).join(', '))

    connect(modList)
  })
}

function connect (modList) {
  const client = mc.createClient({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    // No password => offline mode. Server needs online-mode=false.
    keepAlive: true
  })

  // Forge/FML handshake, announcing the same mods the server has.
  forge.forgeHandshake(client, { forgeMods: modList })

  client.on('connect', () => log('Connected, logging in ...'))

  client.on('login', (packet) => {
    log(`Joined the server as ${USERNAME} (entity id ${packet.entityId})`)
  })

  // Reply to server position packets so the server treats us as fully spawned.
  client.on('position', (p) => {
    try {
      client.write('position_look', {
        x: p.x,
        stance: p.y,
        y: p.y - 1.62,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        onGround: true
      })
    } catch (e) {
      log('position reply failed:', e.message)
    }
  })

  client.on('chat', (packet) => {
    try {
      const msg = JSON.parse(packet.message)
      const text = (msg.text || '') + (msg.extra ? msg.extra.map(e => e.text || '').join('') : '')
      if (text) log('[chat]', text)
    } catch (_) {}
  })

  client.on('kick_disconnect', (packet) => log('Kicked:', packet.reason))
  client.on('error', (err) => log('Error:', err.message))

  client.on('end', (reason) => {
    log('Disconnected:', reason, `- reconnecting in ${RECONNECT_DELAY_MS / 1000}s`)
    setTimeout(start, RECONNECT_DELAY_MS)
  })
}

start()
