const mc = require('minecraft-protocol');
const { autoVersionForge } = require('minecraft-protocol-forge');

const HOST = (process.env.MC_HOST || '').trim();
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = (process.env.MC_USERNAME || 'ActionBot').trim();

const RETRY_DELAY_MS = 15_000;
const LOGIN_TIMEOUT_MS = 30_000;

// End this run before GitHub's six-hour job limit.
const MAX_RUNTIME_MS = 345 * 60 * 1000;

if (!HOST) {
  throw new Error('Missing MC_HOST repository secret.');
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('MC_PORT must be between 1 and 65535.');
}

if (!/^[A-Za-z0-9_]{1,16}$/.test(USERNAME)) {
  throw new Error(
    'MC_USERNAME must contain 1-16 letters, numbers, or underscores.'
  );
}

let stopping = false;
let activeClient = null;
let activeFinish = null;

const stopAt = Date.now() + MAX_RUNTIME_MS;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectOnce() {
  return new Promise(resolve => {
    let client = null;
    let finished = false;
    let loginTimer = null;

    function finish(reason) {
      if (finished) return;

      finished = true;

      if (loginTimer) {
        clearTimeout(loginTimer);
      }

      if (activeClient === client) {
        activeClient = null;
      }

      if (activeFinish === finish) {
        activeFinish = null;
      }

      console.log(
        `[${new Date().toISOString()}] Connection ended: ${String(reason)}`
      );

      resolve();
    }

    activeFinish = finish;

    try {
      console.log(
        `[${new Date().toISOString()}] Connecting to ${HOST}:${PORT} as ${USERNAME}`
      );

      client = mc.createClient({
        host: HOST,
        port: PORT,
        username: USERNAME,
        version: false,
        auth: 'offline',
        keepAlive: true
      });

autoVersionForge(client);

      client.on('login', () => {
        if (loginTimer) {
          clearTimeout(loginTimer);
        }

        console.log('Successfully joined Minecraft 1.7.10.');
      });

      client.on('kick_disconnect', packet => {
        console.log('Server kick:', JSON.stringify(packet));
      });

      client.on('end', reason => {
        finish(reason || 'Server closed the connection');
      });

      client.on('error', error => {
        console.error('Connection error:', error.message);

        try {
          client.end('Connection error');
        } catch {}

        finish(`Error: ${error.message}`);
      });

      loginTimer = setTimeout(() => {
        if (finished) return;

        console.log('Login timed out; preparing to reconnect.');

        try {
          client.end('Login timeout');
        } catch {}

        finish('Login timeout');
      }, LOGIN_TIMEOUT_MS);

    } catch (error) {
      finish(`Connection setup failed: ${error.message}`);
    }
  });
}

async function main() {
  console.log('Minecraft bot started.');
  console.log('Protocol: 1.7.10 | Authentication: offline');

  while (!stopping && Date.now() < stopAt) {
    await connectOnce();

    if (stopping || Date.now() >= stopAt) {
      break;
    }

    const waitMs = Math.min(
      RETRY_DELAY_MS,
      Math.max(0, stopAt - Date.now())
    );

    console.log(
      `Retrying connection in ${Math.ceil(waitMs / 1000)} seconds...`
    );

    await sleep(waitMs);
  }

  console.log('This GitHub Actions session has finished.');
}

const stopTimer = setTimeout(() => {
  stopping = true;

  console.log('Ending this run before the GitHub Actions time limit.');

  if (activeClient) {
    try {
      activeClient.end('Scheduled run ending');
    } catch {}
  }

  if (activeFinish) {
    activeFinish('Scheduled run ending');
  }
}, MAX_RUNTIME_MS);

main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(stopTimer);
  });
