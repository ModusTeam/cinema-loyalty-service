import { spawnSync } from 'node:child_process';

const compose = [
  'compose',
  '-p',
  `loyalty-integration-${process.pid}`,
  '-f',
  'test/docker-compose.integration.yml',
];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}

try {
  run('docker', [...compose, 'up', '-d', '--wait']);
  const result = spawnSync('docker', [...compose, 'port', 'postgres', '5432'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const address = result.stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error(`Unexpected database address: ${address}`);
  const databaseUrl = `postgresql://loyalty_test:integration_test@${address}/loyalty_integration`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    INTEGRATION_DATABASE_URL: databaseUrl,
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
  };
  run(process.execPath, ['x', 'prisma', 'migrate', 'deploy'], env);
  run(
    process.execPath,
    [
      'run',
      'test',
      '--config',
      'test/jest-integration.json',
      '--runInBand',
      '--coverage',
      ...process.argv.slice(2),
    ],
    env,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  const result = spawnSync(
    'docker',
    [...compose, 'down', '--volumes', '--remove-orphans'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exitCode = 1;
}
