
'use strict';

const mc = require('minecraft-protocol');
const { forgeHandshake } = require('minecraft-protocol-forge');

const HOST = (process.env.MC_HOST || '').trim().replace(/\.$/, '');
const USERNAME = (process.env.MC_USERNAME || '').trim();

const PORT = 25565;
const RETRY_DELAY = 15000;
const LOGIN_TIMEOUT = 60000;

if (!HOST) {
  console.error('ERROR: MC_HOST secret is missing.');
  process.exit(1);
}

if (!USERNAME) {
  console.error('ERROR: MC_USERNAME secret is missing.');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getForgeMods() {
  console.log('Checking server status using Minecraft 1.7.10...');

  const status = await mc.ping({
    host: HOST,
    port: PORT,
    version: '1.7.10',
    closeTimeout: 15000,
    noPongTimeout: 3000
  });

  const serverVersion = status.version?.name || 'unknown';
  const protocol = status.version?.protocol;

  console.log(`Server version: ${serverVersion}`);
  console.log(`Server protocol: ${protocol}`);

  if (protocol !== 5) {
    throw new Error(
      `Expected Minecraft 1.7.10 protocol 5, but server reported ${protocol}.`
    );
  }

  const modInfo = status.modinfo;

  if (
    !modInfo ||
    modInfo.type !== 'FML' ||
    !Array.isArray(modInfo.modList)
  ) {
    throw new Error(
      'The server did not advertise its legacy Forge/FML mod list. ' +
      'Cannot automatically prepare the Forge handshake.'
    );
  }

  console.log(`Forge mods detected: ${modInfo.modList.length}`);

  for (const mod of modInfo.modList) {
    console.log(`  ${mod.modid}: ${mod.version}`);
  }

  return modInfo.modList;
}

function connectOnce(forgeMods) {
  return new Promise(resolve => {
    let finished = false;
    let loginTimer;

    function finish() {
      if (finished) return;

      finished = true;
      clearTimeout(loginTimer);
      resolve();
    }

    console.log(`Connecting to ${HOST}:${PORT} as ${USERNAME}...`);

    let client;

    try {
      client = mc.createClient({
        host: HOST,
        port: PORT,
        username: USERNAME,

        // Fix the protocol version instead of auto-detecting it.
        version: '1.7.10',

        // This assumes the Minecraft server accepts offline-mode players.
        auth: 'offline',
        keepAlive: true,

        // Preserve the original host and the legacy Forge marker.
        fakeHost: `${HOST}\0FML\0`
      });

      client.on('login', () => {
        clearTimeout(loginTimer);
        console.log(`Logged in successfully as ${USERNAME}.`);
      });

      client.on('playerJoin', () => {
        console.log('Bot has joined the game.');
      });

      client.on('end', reason => {
        console.log(`Disconnected: ${reason || 'connection closed'}`);
        finish();
      });

      client.on('error', error => {
        console.error(`Minecraft client error: ${error.message}`);
      });

      // Use the mod list reported by this server.
      forgeHandshake(client, { forgeMods });

      loginTimer = setTimeout(() => {
        console.error('Login timed out after 60 seconds.');

        try {
          client.end('Login timeout');
        } catch (_) {
          // The client may already be disconnected.
        }

        finish();
      }, LOGIN_TIMEOUT);
    } catch (error) {
      console.error(`Connection setup failed: ${error.message}`);
      finish();
    }
  });
}

async function main() {
  console.log('Minecraft 1.7.10 Forge bot starting...');
  console.log(`Configured host: ${HOST}`);
  console.log(`Username: ${USERNAME}`);

  while (true) {
    try {
      const forgeMods = await getForgeMods();
      await connectOnce(forgeMods);
    } catch (error) {
      console.error(`Attempt failed: ${error.message}`);
    }

    console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
    await sleep(RETRY_DELAY);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
