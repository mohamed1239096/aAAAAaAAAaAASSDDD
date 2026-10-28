// Minecraft 1.7.10 Forge bot
// Joins the server, completes the Forge (FML) handshake with its own handler,
// stays online, and reconnects automatically if it gets disconnected.
//
// Address handling: if MC_PORT is empty, the bot looks up the SRV record
// (_minecraft._tcp.<host>) like the Minecraft client does when you join with
// only a hostname, and falls back to port 25565. If MC_PORT is set, it is used.

const dns = require('dns').promises
const mc = require('minecraft-protocol')

const CONFIG_HOST = (process.env.MC_HOST || '').trim()
const CONFIG_PORT = (process.env.MC_PORT || '').trim()
const USERNAME = (process.env.MC_USERNAME || 'ServerBot').trim()
const VERSION = '1.7.10'
const RECONNECT_DELAY_MS = 15000

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

// ---------------------------------------------------------------------------
// Forge / FML handshake (FML|HS channel), protocol for Minecraft 1.7.10
//
//   S->C ServerHello
//   C->S REGISTER, ClientHello, ModList
//   S->C ModList                      C->S Ack(2)  WAITINGSERVERDATA
//   S->C registry data (1+ packets)   C->S Ack(3)  WAITINGSERVERCOMPLETE (after the last one)
//   S->C Ack(2)                       C->S Ack(4)  PENDINGCOMPLETE
//   S->C Ack(3)                       C->S Ack(5)  COMPLETE
//
// Messages are answered by what they ARE (not by a strict state machine), so a
// slightly different ordering on the server side can't crash the bot.
// ---------------------------------------------------------------------------

const D_SERVER_HELLO = 0
const D_CLIENT_HELLO = 1
const D_MOD_LIST = 2
const D_REGISTRY = 3
const D_ACK = -1
const D_RESET = -2

function writeVarInt (value) {
  const out = []
  do {
    let b = value & 0x7f
    value >>>= 7
    if (value !== 0) b |= 0x80
    out.push(b)
  } while (value !== 0)
  return Buffer.from(out)
}

function writeString (str) {
  const body = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

function readVarInt (buf, offset) {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos++]
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: result, next: pos }
    shift += 7
    if (shift > 35) break
  }
  return null
}

// Newer-style registry packet: [hasMore:bool][registryName:string][count:varint]...
// Old 1.7.10 ModIdData packet:  [count:varint]... (no hasMore flag, single packet)
// Returns hasMore = true/false, or null if the packet is not in the newer style.
function parseRegistryHasMore (data) {
  // data[0] is the discriminator, payload starts at 1
  if (data.length < 4) return null
  const flag = data[1]
  if (flag !== 0 && flag !== 1) return null
  const nameLen = readVarInt(data, 2)
  if (!nameLen || nameLen.value < 3 || nameLen.value > 64) return null
  const end = nameLen.next + nameLen.value
  if (end > data.length) return null
  const name = data.slice(nameLen.next, end).toString('utf8')
  if (!/^[\w:.\-|]+$/.test(name)) return null
  return flag === 1
}

function attachForgeHandshake (client, forgeMods, logFn) {
  const say = logFn || (() => {})
  client.tagHost = '\0FML\0' // tells the server we are a Forge client

  const send = (channel, data) => client.write('custom_payload', { channel, data })
  const ack = (phase) => send('FML|HS', Buffer.from([0xff, phase]))

  client.on('custom_payload', (packet) => {
    if (packet.channel !== 'FML|HS') return
    const data = Buffer.isBuffer(packet.data) ? packet.data : Buffer.from(packet.data)
    if (data.length === 0) return
    const disc = data.readInt8(0)

    try {
      switch (disc) {
        case D_SERVER_HELLO: {
          const serverVersion = data.length > 1 ? data[1] : 2
          say(`FML: ServerHello (protocol ${serverVersion})`)
          send('REGISTER', Buffer.from(['FML|HS', 'FML', 'FML|MP', 'FML', 'FORGE'].join('\0')))
          send('FML|HS', Buffer.from([D_CLIENT_HELLO, serverVersion]))
          const parts = [Buffer.from([D_MOD_LIST]), writeVarInt(forgeMods.length)]
          for (const m of forgeMods) {
            parts.push(writeString(m.modid), writeString(String(m.version)))
          }
          send('FML|HS', Buffer.concat(parts))
          break
        }

        case D_MOD_LIST:
          say('FML: server ModList received, sending Ack(2)')
          ack(2)
          break

        case D_REGISTRY: {
          const hasMore = parseRegistryHasMore(data)
          if (hasMore === true) {
            say('FML: registry data (more to come)')
          } else {
            say('FML: last registry data, sending Ack(3)')
            ack(3)
          }
          break
        }

        case D_ACK: {
          const phase = data.length > 1 ? data[1] : -1
          say(`FML: server Ack(${phase})`)
          if (phase === 2) ack(4)
          else if (phase === 3) {
            ack(5)
            say('FML: handshake complete')
          }
          break
        }

        case D_RESET:
          say('FML: HandshakeReset received (ignored)')
          break

        default:
          say(`FML: unknown message type ${disc} (ignored)`)
      }
    } catch (e) {
      say('FML: handshake error:', e.message)
    }
  })
}

// ---------------------------------------------------------------------------
// Connection logic
// ---------------------------------------------------------------------------

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

  attachForgeHandshake(client, modList, log)

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

// Keep the process alive even if something unexpected throws.
process.on('uncaughtException', (e) => log('Uncaught error:', e.message))
process.on('unhandledRejection', (e) => log('Unhandled rejection:', e && e.message ? e.message : e))

if (require.main === module) {
  if (!CONFIG_HOST) {
    console.error('MC_HOST is not set. Add it as a GitHub secret.')
    process.exit(1)
  }
  start()
}

module.exports = { attachForgeHandshake, parseRegistryHasMore }
