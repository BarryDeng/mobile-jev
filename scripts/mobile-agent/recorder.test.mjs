import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording } from './recorder.mjs';

function fakeScrcpy({ output = 'INFO: Recording started to mkv file: x.mkv\n', exitCode } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 1;
      setImmediate(() => child.emit('exit', 1));
    };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (exitCode !== undefined) {
        child.stderr.emit('data', Buffer.from('ERROR: no device\n'));
        child.exitCode = exitCode;
        child.emit('exit', exitCode);
      } else child.stderr.emit('data', Buffer.from(output));
    });
    return child;
  };
  return { spawn, calls };
}

test('recording starts scrcpy on the agent adb and reports video offsets', async () => {
  const { spawn, calls } = fakeScrcpy();
  let clock = 1000;
  const path = join(tmpdir(), 'jev-rec', 'run.mkv');
  const recording = await startRecording({
    path,
    serial: '192.168.1.2:5555',
    scrcpyPath: 'scrcpy.exe',
    adbPath: 'C:\\adb\\adb.exe',
    spawn,
    now: () => clock,
  });
  const [{ command, args, options, child }] = calls;
  assert.equal(command, 'scrcpy.exe');
  assert.ok(args.includes('--no-window') && args.includes('--no-control'));
  assert.ok(args.includes(`--record=${path}`) && args.includes('--serial=192.168.1.2:5555'));
  assert.equal(options.env.ADB, 'C:\\adb\\adb.exe');
  clock = 3500;
  assert.equal(recording.videoMs(), 2500);
  const stopped = await recording.stop();
  assert.ok(child.killed);
  assert.deepEqual(stopped, { path, startedAt: 1000, stoppedAt: 3500 });
});

test('recording rejects non-mkv paths and reports scrcpy failures', async () => {
  await assert.rejects(startRecording({ path: 'run.mp4' }), /\.mkv/);
  const { spawn } = fakeScrcpy({ exitCode: 1 });
  await assert.rejects(
    startRecording({ path: join(tmpdir(), 'jev-rec', 'fail.mkv'), spawn }),
    /exited \(1\)[\s\S]*no device/,
  );
});
