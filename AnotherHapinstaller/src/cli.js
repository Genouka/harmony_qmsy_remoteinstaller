#!/usr/bin/env node

require('./db/database');

const installer = require('./services/installer');

function parseArgs(argv) {
  const params = {
    username: '',
    password: '',
    accessToken: '',
    userId: '',
    hapId: '',
    ip: '',
    port: 0
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--username' && i + 1 < argv.length) {
      params.username = argv[++i];
    } else if (arg === '--password' && i + 1 < argv.length) {
      params.password = argv[++i];
    } else if (arg === '--access-token' && i + 1 < argv.length) {
      params.accessToken = argv[++i];
    } else if (arg === '--user-id' && i + 1 < argv.length) {
      params.userId = argv[++i];
    } else if (arg === '--hap-id' && i + 1 < argv.length) {
      params.hapId = argv[++i];
    } else if (arg === '-IP' && i + 1 < argv.length) {
      const ipPort = argv[++i];
      const colonPos = ipPort.lastIndexOf(':');
      if (colonPos !== -1) {
        params.ip = ipPort.substring(0, colonPos);
        params.port = parseInt(ipPort.substring(colonPos + 1), 10);
      } else {
        params.ip = ipPort;
        params.port = 0;
      }
    }
  }

  return params;
}

function printUsage() {
  console.log('Usage: hapinstaller [options]');
  console.log('Options:');
  console.log('  --username <uid>      User name');
  console.log('  --password <pwd>      Password');
  console.log('  --access-token <aid>  Access token (for Huawei OAuth)');
  console.log('  --user-id <urid>      User ID (for Huawei OAuth)');
  console.log('  --hap-id <hid>        HAP package ID');
  console.log('  -IP <ip:port>         Target IP and port');
}

async function main() {
  console.log('AnotherHapInstaller CLI');
  console.log('========================');

  if (process.argv.length < 3) {
    printUsage();
    process.exit(1);
  }

  const params = parseArgs(process.argv);

  console.log('Parameters:');
  console.log(`  Username:     ${params.username}`);
  console.log(`  Password:     ${'*'.repeat(params.password.length)}`);
  console.log(`  Access Token: ${params.accessToken}`);
  console.log(`  User ID:      ${params.userId}`);
  console.log(`  HAP ID:       ${params.hapId}`);
  console.log(`  Target IP:    ${params.ip}`);
  console.log(`  Target Port:  ${params.port}`);
  console.log('');

  if (!params.username || !params.password) {
    console.error('[ERROR] --username 和 --password 不能为空');
    process.exit(1);
  }

  if (!params.hapId) {
    console.error('[ERROR] --hap-id 不能为空');
    process.exit(1);
  }

  try {
    const result = await installer.execute({
      username: params.username,
      password: params.password,
      accessToken: params.accessToken,
      userId: params.userId,
      hapId: params.hapId,
      ip: params.ip,
      port: params.port
    });

    console.log('');
    if (result.success) {
      console.log(`[完成] ${result.message}`);
    } else {
      console.error(`[失败] ${result.message}`);
    }

    const db = require('./db/database');
    db.close();

    process.exit(result.exitCode);
  } catch (err) {
    console.error(`[异常] ${err.message}`);

    const db = require('./db/database');
    db.close();

    process.exit(99);
  }
}

main();
