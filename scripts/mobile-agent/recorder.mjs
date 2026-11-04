import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

// Records the whole run with scrcpy (no window, no audio) so failures can be diagnosed from video
// without extra screenshots. Matroska survives an abrupt stop, so it is the only container allowed.
export async function startRecording({
  path,
  serial,
  scrcpyPath = process.env.SCRCPY_PATH || 'scrcpy',
  adbPath = process.env.ADB_PATH,
  maxSize = 1280,
  maxFps = 15,
  bitRate = '2M',
  timeoutMs = 20_000,
  spawn = nodeSpawn,
  now = Date.now,
} = {}) {
  if (!path || extname(path).toLowerCase() !== '.mkv')
    throw new Error('--record needs a .mkv path (it stays playable when recording is cut off).');
  await mkdir(dirname(path), { recursive: true });
  const args = [
    '--no-window',
    '--no-audio',
    '--no-control',
    `--max-size=${maxSize}`,
    `--max-fps=${maxFps}`,
    `--video-bit-rate=${bitRate}`,
    `--record=${path}`,
    ...(serial ? [`--serial=${serial}`] : []),
  ];
  // scrcpy must use the same adb as the agent: two adb versions restart each other's server.
  const child = spawn(scrcpyPath, args, {
    env: { ...process.env, ...(adbPath ? { ADB: adbPath } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', (error) => {
      log += `\n${error.message}`;
      resolve(null);
    });
  });
  const startedAt = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`scrcpy did not start recording within ${timeoutMs} ms.\n${log.trim()}`));
    }, timeoutMs);
    const onData = (chunk) => {
      log += chunk.toString('utf8');
      if (/Recording started/i.test(log)) {
        clearTimeout(timer);
        resolve(now());
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`scrcpy exited (${code}) before recording.\n${log.trim()}`));
    });
  });
  return {
    path,
    startedAt,
    // Offset into the video, to find a trace event in the recording.
    videoMs: (at = now()) => Math.max(0, at - startedAt),
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
      return { path, startedAt, stoppedAt: now() };
    },
  };
}
