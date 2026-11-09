import { spawn } from 'node:child_process';
const children = [
  ['node', ['--experimental-transform-types', '--watch', 'apps/api/src/server.ts']],
  ['node', ['--experimental-transform-types', '--watch', 'apps/generator/src/server.ts']],
  ['npm', ['run', 'dev', '-w', 'apps/web']],
].map(([cmd, args]) => spawn(cmd, args, { stdio: 'inherit' }));
const stop = () => {
  for (const c of children) c.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children)
  c.on('exit', () => {
    stop();
    process.exitCode = 1;
  });
