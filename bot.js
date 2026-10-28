// Minecraft 1.7.10 Forge bot
// Joins the server, completes the Forge (FML) handshake using the server's own
// mod list, stays online, and reconnects automatically if it gets disconnected.
//
// Address handling: if MC_PORT is empty, the bot looks up the SRV record
// (_minecraft._tcp.<host>) exactly like the Minecraft client does when you
// join with only a hostname. If MC_PORT is set, that port is used directly.

const dns = require('dns').promises
const mc = require('minecraft-protocol')
const forge = require('minecraft-protocol-forge')

const CONFIG_HOST = (process.env.MC_HOST || '').trim()
const CONFIG_PORT = (process.env.MC_PORT || '').trim()
const USERNAME = (process.env.MC_USERNAME || 'ServerBot').trim()
const VERSION = '1.7.10'
const RECONNECT_DELAY_MS = 15000

if (!CONFIG_HOST) {
  console.error('MC_HOST is not set. Add it as a GitHub secret.')
  process.exit(1)
}

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

// Work out the real host/port to connect to.
async function resolveAddress () {
  if (CONFIG_PORT) {
    return { host: CONFIG_HOST, port: parseInt(CONFIG_PORT, 10) }
  }

  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${CONFIG_HOST}`)
    if (records.length > 0) {
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      const r = records[0]
      log(`SRV record found: ${CONFIG_HOST} -> ${r.name}:${r.port}`)
      return { host: r.name, port: r.port }
    }
  } catch (e) {
    log(`No SRV record for ${CONFIG_HOST} (${e.code || e.message}), using default port 25565`)
  }

  return { host: CONFIG_HOST, port: 25565 }
}

async function start () {
  let addr
  try {
    addr = await resolveAddress()
  } catch (e) {
    log('Address lookup failed:', e.message)
    return setTimeout(start, RECONNECT_DELAY_MS)
  }

  log(`Pinging ${addr.host}:${addr.port} ...`)

  // Ping first so we can copy the server's mod list for the Forge handshake.
  mc.ping({ host: addr.host, port: addr.port, version: VERSION }, (err, result) => {
    if (err) {
      log('Ping failed:', err.message)
      return setTimeout(start, RECONNECT_DELAY_MS)
    }

    const modList = (result && result.modinfo && result.modinfo.modList) || []
    log(`Server reports ${modList.length} Forge mod(s):`,
      modList.map(m => `${m.modid}@${m.version}`).join(', '))

    connect(addr, modList)
  })
}

function connect (addr, modList) {
  const client = mc.createClient({
    host: addr.host,
    port: addr.port,
    username: USERNAME,
    version: VERSION,
    // No password => offline mode.
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
