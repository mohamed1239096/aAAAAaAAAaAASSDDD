
'use strict';

const mc = require('minecraft-protocol');
const { autoVersionForge } = require('minecraft-protocol-forge');
const dns = require('node:dns').promises;

const HOST = (process.env.MC_HOST || '').trim().replace(/\.$/, '');
const USERNAME = (process.env.MC_USERNAME || 'ActionBot').trim();

const FALLBACK_PORT = 25565;
const RETRY_DELAY = 15000;
const CONNECTION_TIMEOUT = 60000;

if (!HOST) {
  console.error('ERROR: MC_HOST is missing.');
  process.exit(1);
}

if (!USERNAME) {
  console.error('ERROR: MC_USERNAME is missing.');
  process.exit(1);
}

async function resolveMinecraftAddress() {
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${HOST}`);

    if (records.length > 0) {
      records.sort((a, b) => a.priority - b.priority);

      const record = records[0];
      const targetHost = record.name.replace(/\.$/, '');

      console.log(`SRV record found: ${targetHost}:${record.port}`);

      return {
        host: targetHost,
        port: record.port
      };
    }
  } catch (error) {
    console.log(
      `SRV lookup failed (${error.code || error.message}).`
    );
  }

  // Match normal Minecraft Java address behavior when SRV is absent.
  console.log(
    `Using default Minecraft port: ${HOST}:${FALLBACK_PORT}`
  );

  return {
    host: HOST,
    port: FALLBACK_PORT
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectOnce(address) {
  return new Promise(resolve => {
    let client;
    let finished = false;
    let watchdog;

    function finish() {
      if (finished) return;

      finished = true;
      clearTimeout(watchdog);
      resolve();
    }

    console.log(
      `Connecting as ${USERNAME} to ${address.host}:${address.port}...`
    );

    try {
      client = mc.createClient({
        host: address.host,
        port: address.port,

        // Send the original hostname in the Minecraft handshake.
        fakeHost: HOST,

        username: USERNAME,
        auth: 'offline',
        version: false,
        keepAlive: true
      });

      autoVersionForge(client);

      client.on('login', () => {
        console.log(`Successfully logged in as ${USERNAME}.`);
      });

      client.on('end', reason => {
        console.log(`Disconnected: ${reason || 'connection closed'}`);
        finish();
      });

      client.on('error', error => {
        console.error(`Minecraft error: ${error.message}`);
      });

      watchdog = setTimeout(() => {
        console.log('Connection lasted too long without disconnecting.');
        try {
          client.end('Connection watchdog timeout');
        } catch (_) {
          // The connection may already be closed.
        }
        finish();
      }, CONNECTION_TIMEOUT);
    } catch (error) {
      console.error(`Connection setup failed: ${error.message}`);
      finish();
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
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
