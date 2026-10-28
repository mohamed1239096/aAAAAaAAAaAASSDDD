
'use strict';

const mc = require('minecraft-protocol');
const { autoVersionForge } = require('minecraft-protocol-forge');
const dns = require('node:dns').promises;
const net = require('node:net');

const HOST = (process.env.MC_HOST || '').trim().replace(/\.$/, '');
const USERNAME = (process.env.MC_USERNAME || 'ActionBot').trim();
const ENV_PORT = Number(process.env.MC_PORT || 25565);
const RETRY_DELAY = 15000;

if (!HOST) {
  console.error('ERROR: MC_HOST is missing.');
  process.exit(1);
}

if (!USERNAME) {
  console.error('ERROR: MC_USERNAME is missing.');
  process.exit(1);
}

if (!Number.isInteger(ENV_PORT) || ENV_PORT < 1 || ENV_PORT > 65535) {
  console.error('ERROR: MC_PORT must be a valid port.');
  process.exit(1);
}

// Resolve the actual destination using Minecraft DNS SRV.
async function resolveMinecraftAddress() {
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${HOST}`);

    if (records.length > 0) {
      records.sort((a, b) =>
        a.priority - b.priority || b.weight - a.weight
      );

      const record = records[0];
      const target = record.name.replace(/\.$/, '');

      console.log(`DNS SRV found: ${target}:${record.port}`);

      return {
        targetHost: target,
        targetPort: record.port
      };
    }
  } catch (error) {
    if (error.code !== 'ENODATA' &&
        error.code !== 'ENOTFOUND' &&
        error.code !== 'ESERVFAIL') {
      console.log(`SRV lookup warning: ${error.message}`);
    }
  }

  console.log(`No SRV record found; using ${HOST}:${ENV_PORT}`);

  return {
    targetHost: HOST,
    targetPort: ENV_PORT
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectOnce(address) {
  return new Promise(resolve => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    console.log(
      `Connecting as ${USERNAME} to ` +
      `${address.targetHost}:${address.targetPort}...`
    );

    let client;

    try {
      client = mc.createClient({
        host: HOST,
        port: address.targetPort,
        username: USERNAME,
        auth: 'offline',
        version: false,
        keepAlive: true,

        // Preserve the hostname used by the Minecraft client.
        fakeHost: HOST,

        // Connect the TCP socket to the SRV destination.
        connect: (clientInstance) => {
          const socket = net.createConnection({
            host: address.targetHost,
            port: address.targetPort
          });

          clientInstance.setSocket(socket);

          socket.setTimeout(20000);

          socket.on('connect', () => {
            console.log('TCP connection established.');
            clientInstance.emit('connect');
          });

          socket.on('timeout', () => {
            socket.destroy(new Error('Connection timed out.'));
          });

          socket.on('error', error => {
            console.error(`Socket error: ${error.message}`);
          });
        }
      });

      autoVersionForge(client);

      client.on('login', () => {
        console.log(`Logged in successfully as ${USERNAME}.`);
      });

      client.on('playerJoin', () => {
        console.log('Player joined the game.');
      });

      client.on('end', reason => {
        console.log(`Disconnected: ${reason || 'connection closed'}`);
        finish();
      });

      client.on('error', error => {
        console.error(`Minecraft error: ${error.message}`);
      });
    } catch (error) {
      console.error(`Connection setup failed: ${error.message}`);
      finish();
      return;
    }
  });
}

async function main() {
  console.log('Minecraft 1.7.10 bot starting...');
  console.log(`Configured server: ${HOST}`);
  console.log(`Username: ${USERNAME}`);

  while (true) {
    try {
      const address = await resolveMinecraftAddress();
      await connectOnce(address);
    } catch (error) {
      console.error(`Unexpected error: ${error.message}`);
    }

    console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
    await sleep(RETRY_DELAY);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
