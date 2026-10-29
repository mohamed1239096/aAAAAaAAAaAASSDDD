// Minecraft bot for Paper 26.3 (default) or old Forge 1.7.10 (MC_FORGE=true)
//
// - Joins the server (and completes the Forge (FML) handshake itself if MC_FORGE=true).
// - If it gets disconnected for ANY reason, it reconnects.
// - If the server is down (ping fails several times in a row), it stops and
//   exits cleanly. The GitHub Actions schedule starts it again later, and the
//   bot only stays up if the server answers.
// - Exits cleanly before GitHub's 6-hour job limit so the next run takes over.
//
// Address handling: if MC_PORT is empty, the bot looks up the SRV record
// (_minecraft._tcp.<host>) like the Minecraft client does when you join with
// only a hostname, and falls back to port 25565. If MC_PORT is set, it is used.

const dns = require('dns').promises
const mc = require('minecraft-protocol')

const CONFIG_HOST = (process.env.MC_HOST || '').trim()
const CONFIG_PORT = (process.env.MC_PORT || '').trim()
const USERNAME = (process.env.MC_USERNAME || 'ServerBot').trim()
const num = (name, fallback) => {
  const v = parseInt(process.env[name] || '', 10)
  return Number.isFinite(v) ? v : fallback
}

// Which packet definitions the library should use. The newest ones it ships
// for modern servers are "26.1". Minecraft 26.3 isn't in the library yet, so
// the bot talks 26.1 packets but announces the real protocol number of the
// server (777 = Minecraft 26.3). Set MC_VERSION / MC_PROTOCOL to change this.
//   Paper 26.3  -> MC_VERSION=26.1  MC_PROTOCOL=777  (default)
//   Paper 26.1  -> MC_VERSION=26.1  MC_PROTOCOL=775
//   Forge 1.7.10-> MC_VERSION=1.7.10 MC_PROTOCOL=5 MC_FORGE=true
const VERSION = (process.env.MC_VERSION || '26.1').trim()
const PROTOCOL = num('MC_PROTOCOL', 777)
const FORGE = (process.env.MC_FORGE || '').trim().toLowerCase() === 'true'
// MC_DEBUG=true prints every packet parse problem (very noisy, only for troubleshooting).
const DEBUG = (process.env.MC_DEBUG || '').trim().toLowerCase() === 'true'
// Minecraft 26.3 (protocol 777) renumbered some packets compared to 26.1; patched in below.
const PATCH_26_3 = PROTOCOL === 777 && VERSION === '26.1' &&
  (process.env.MC_PATCH || '').trim().toLowerCase() !== 'off'

const RECONNECT_DELAY_MS = num('RECONNECT_DELAY_MS', 15000) // wait before reconnecting
const PING_RETRIES = num('PING_RETRIES', 3) // server counts as down after this many failed pings
const PING_RETRY_DELAY_MS = num('PING_RETRY_DELAY_MS', 10000)
const PING_TIMEOUT_MS = num('PING_TIMEOUT_MS', 10000)
const LOGIN_TIMEOUT_MS = num('LOGIN_TIMEOUT_MS', 45000) // give up on a join attempt that hangs
const MAX_FAILED_JOINS = num('MAX_FAILED_JOINS', 20) // server is up but we can never get in
const MAX_RUNTIME_MS = num('MAX_RUNTIME_MS', 345 * 60 * 1000) // hand over before the 6h limit

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// ---------------------------------------------------------------------------
// Minecraft 26.3 packet numbering
//
// The library only knows the packet tables of 26.1. Compared with 26.1, the
// 26.3 server (from ViaVersion's protocol tables) inserts NEW server->client
// packets and keeps the order of all others, which shifts the numbers behind
// each insertion by one:
//   configuration phase: 1 new packet at 0x0a                       (post_effects)
//   play phase:          3 new packets at 0x25, 0x53, 0x7b          (add_transient_block,
//                                                                    post_effects, swing_animation)
// Packets the bot SENDS keep their numbers. This patch re-numbers the library's
// 26.1 table in memory; the new packets are skipped (they are not needed to stay online).
// ---------------------------------------------------------------------------
const INSERTED_PACKETS_26_3 = { configuration: [0x0a], play: [0x25, 0x53, 0x7b] }
let patched26_3 = false

function patchProtocol26_3 () {
  if (patched26_3) return
  patched26_3 = true
  const protocol = require('minecraft-data')('26.1').protocol

  for (const [state, inserts] of Object.entries(INSERTED_PACKETS_26_3)) {
    const dir = protocol[state].toClient
    const packetType = dir.types.packet // ['container', [{name: 'name', type: ['mapper', {...}]}, {name: 'params', type: ['switch', {...}]}]]
    const mapper = packetType[1][0].type[1]
    const sw = packetType[1][1].type[1]

    const names = Object.keys(mapper.mappings)
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16))
      .map((k) => mapper.mappings[k])

    dir.types.packet_new_in_26_3 = ['container', []] // reads nothing: the packet is just skipped
    for (const id of [...inserts].sort((a, b) => a - b)) {
      const name = `new_in_26_3_${state}_${id}`
      names.splice(id, 0, name)
      sw.fields[name] = 'packet_new_in_26_3'
    }

    mapper.mappings = {}
    names.forEach((name, id) => { mapper.mappings['0x' + id.toString(16).padStart(2, '0')] = name })
  }

  skipUnneededPackets(protocol)

  // In 26.3 the "accept teleportation" packet the bot SENDS also carries the
  // position and rotation (teleport id, x, y, z, yaw, pitch). Without them the
  // server cannot decode it and kicks the bot.
  protocol.play.toServer.types.packet_teleport_confirm = ['container', [
    { name: 'teleportId', type: 'varint' },
    { name: 'x', type: 'f64' },
    { name: 'y', type: 'f64' },
    { name: 'z', type: 'f64' },
    { name: 'yaw', type: 'f32' },
    { name: 'pitch', type: 'f32' }
  ]]
}

// While playing, the bot only needs a handful of server packets. Every other
// packet (chunks, entities, recipes, ...) is NOT read at all. This matters
// because 26.3 changed the layout of several of them, and when the library
// fails to read one it throws away its receive buffer, which corrupts everything
// after it (including the keep-alive, so the server kicks the bot for timing out).
// The packets are still received and framed, only their content is ignored.
const PLAY_PACKETS_TO_READ = ['keep_alive', 'ping', 'position', 'kick_disconnect', 'start_configuration']

function skipUnneededPackets (protocol) {
  if ((process.env.MC_PARSE_ALL || '').trim().toLowerCase() === 'true') return
  const dir = protocol.play.toClient
  const sw = dir.types.packet[1][1].type[1]
  dir.types.packet_new_in_26_3 = ['container', []]
  for (const name of Object.keys(sw.fields)) {
    if (!PLAY_PACKETS_TO_READ.includes(name)) sw.fields[name] = 'packet_new_in_26_3'
  }
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

// One ping attempt. Resolves with the ping result, or null if it failed/timed out.
function pingOnce (addr) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS)
    try {
      mc.ping({ host: addr.host, port: addr.port, version: VERSION }, (err, result) => {
        if (err) {
          log('Ping failed:', err.message)
          return finish(null)
        }
        finish(result || {})
      })
    } catch (e) {
      log('Ping error:', e.message)
      finish(null)
    }
  })
}

// Ping several times. Returns the result as soon as one succeeds, or null if
// every attempt failed (= the server is down).
async function pingWithRetries (addr) {
  for (let attempt = 1; attempt <= PING_RETRIES; attempt++) {
    log(`Pinging ${addr.host}:${addr.port} (attempt ${attempt}/${PING_RETRIES}) ...`)
    const result = await pingOnce(addr)
    if (result) return result
    if (attempt < PING_RETRIES) await sleep(PING_RETRY_DELAY_MS)
  }
  return null
}

// One connection attempt. Resolves when the connection ends, for any reason,
// with { joined } telling whether we made it into the game.
function connectOnce (addr, modList) {
  return new Promise((resolve) => {
    let joined = false
    let finished = false
    let loginTimer = null

    const options = {
      host: addr.host,
      port: addr.port,
      username: USERNAME,
      version: VERSION,
      // No password => offline mode.
      keepAlive: true,
      hideErrors: !DEBUG // don't spam the log with packets the library can't fully read
    }
    const client = mc.createClient(options)
    // The library fills in the protocol number from VERSION; replace it with the
    // server's real one (it is only sent later, once the socket connects).
    options.protocolVersion = PROTOCOL
    log(`Using ${VERSION} packet data, protocol number ${PROTOCOL}${FORGE ? ', Forge handshake on' : ''}`)

    const finish = (why) => {
      if (finished) return
      finished = true
      clearTimeout(loginTimer)
      clearInterval(heartbeat)
      log(`Connection ended (${why})`)
      try { client.end() } catch (_) {}
      resolve({ joined })
    }

    if (FORGE) attachForgeHandshake(client, modList, log)

    // A join attempt that hangs forever gets cut off and retried.
    loginTimer = setTimeout(() => {
      if (!joined) finish('login timed out')
    }, LOGIN_TIMEOUT_MS)

    client.on('connect', () => log('Connected, logging in ...'))

    let heartbeat = null
    const markJoined = (extra) => {
      if (joined) return
      joined = true
      clearTimeout(loginTimer)
      log(`Joined the server as ${USERNAME}${extra || ''}`)
      const joinedAt = Date.now()
      heartbeat = setInterval(() => {
        log(`Still connected (${Math.round((Date.now() - joinedAt) / 60000)} min online)`)
      }, 5 * 60 * 1000)
    }

    // Show the connection phases (login -> configuration -> play) to make problems easy to locate.
    client.on('state', (newState) => {
      log(`State: ${newState}`)
      // Being in the play state means the server let us in, even if the "login"
      // packet itself could not be read (it can change between versions).
      if (newState === 'play') markJoined()
    })

    client.on('login', (packet) => {
      if (!joined) markJoined(` (entity id ${packet.entityId})`)
    })

    // Reply to server position packets so the server treats us as fully spawned.
    // The library answers keep-alives by itself; log the first few so problems are easy to see.
    let keepAlives = 0
    client.on('keep_alive', () => {
      keepAlives++
      if (keepAlives <= 3) log(`Keep-alive #${keepAlives} received and answered`)
    })

    // Answer "ping" packets (configuration and play phase) with the matching "pong".
    client.on('ping', (p) => {
      try { client.write('pong', { id: p.id }) } catch (e) { log('pong failed:', e.message) }
    })

    let lastPos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
    client.on('position', (p) => {
      try {
        if (p.teleportId !== undefined) {
          // Modern servers (Paper etc.): confirm the teleport. Values flagged as
          // "relative" are offsets from our previous position.
          const rel = (p.flags && typeof p.flags === 'object') ? p.flags : {}
          lastPos = {
            x: rel.x ? lastPos.x + p.x : p.x,
            y: rel.y ? lastPos.y + p.y : p.y,
            z: rel.z ? lastPos.z + p.z : p.z,
            yaw: rel.yaw ? lastPos.yaw + p.yaw : p.yaw,
            pitch: rel.pitch ? lastPos.pitch + p.pitch : p.pitch
          }
          // 26.3 wants the position in the confirmation too (see patchProtocol26_3).
          client.write('teleport_confirm', PATCH_26_3 ? { teleportId: p.teleportId, ...lastPos } : { teleportId: p.teleportId })
          return
        }
        // Old servers (1.7.10): answer with our position.
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

    // Kick messages (during login, and while playing)
    const reasonText = (r) => (typeof r === 'string' ? r : JSON.stringify(r))
    client.on('disconnect', (packet) => log('Refused by server:', reasonText(packet.reason)))
    client.on('kick_disconnect', (packet) => log('Kicked:', reasonText(packet.reason)))
    // Packets the library can't read are reported, but only the first few so the log stays readable.
    let errorCount = 0
    client.on('error', (err) => {
      errorCount++
      if (DEBUG || errorCount <= 8) log('Error:', String(err.message).split('\n')[0].slice(0, 300))
      else if (errorCount === 9) log('Error: (more errors hidden, set MC_DEBUG=true to see all)')
    })

    client.on('end', (reason) => finish(reason || 'closed'))
    client.on('close', () => finish('socket closed'))
  })
}

async function main () {
  if (PATCH_26_3) {
    patchProtocol26_3()
    log('Applied the Minecraft 26.3 packet-number patch')
  }
  const startedAt = Date.now()
  let failedJoins = 0

  while (true) {
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      log('Reached the max run time. Exiting cleanly so the next scheduled run takes over.')
      return
    }

    let addr = null
    let info = null
    try {
      addr = await resolveAddress()
      info = await pingWithRetries(addr)
    } catch (e) {
      log('Address/ping check failed:', e.message)
    }

    if (!info) {
      log('Server is DOWN (no answer to ping). Stopping. The bot will start again from the next scheduled run once the server is back.')
      return
    }

    const modList = (info.modinfo && info.modinfo.modList) || []
    const serverName = info.version && info.version.name
    log(`Server is up${serverName ? ` (${serverName}, protocol ${info.version.protocol})` : ''}.`,
      FORGE ? `It reports ${modList.length} Forge mod(s): ${modList.map(m => `${m.modid}@${m.version}`).join(', ')}` : '')

    const result = await connectOnce(addr, modList)

    if (result.joined) {
      failedJoins = 0
    } else {
      failedJoins++
      log(`Could not join (${failedJoins}/${MAX_FAILED_JOINS} failed attempts in a row)`)
      if (failedJoins >= MAX_FAILED_JOINS) {
        log('The server answers but the bot can never get in (banned? whitelist? wrong version?). Stopping.')
        return
      }
    }

    log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s ...`)
    await sleep(RECONNECT_DELAY_MS)
  }
}

// Keep the process alive even if something unexpected throws.
process.on('uncaughtException', (e) => log('Uncaught error:', e.message))
process.on('unhandledRejection', (e) => log('Unhandled rejection:', e && e.message ? e.message : e))

if (require.main === module) {
  if (!CONFIG_HOST) {
    console.error('MC_HOST is not set. Add it as a GitHub secret.')
    process.exit(1)
  }
  main().then(() => {
    log('Bot stopped.')
    process.exit(0)
  })
}

module.exports = { attachForgeHandshake, parseRegistryHasMore, patchProtocol26_3 }
