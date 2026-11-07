import { expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it.each(['--no-runInBand', '--runInBand=false', '--maxWorkers=2', '-w2', '--'])(
  'rejects worker control %s before starting integration infrastructure',
  (flag) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // A removed guard must fail this test without reaching a real Docker binary.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key];
    }
    env.PATH = '';
    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, '../test/run-integration.mjs'), flag],
      { env, encoding: 'utf8', timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-mode options');
    expect(result.stdout).toBe('');
  },
);
