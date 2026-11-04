// Long game runs heat a phone until Android throttles it (capture time triples) and can drain it
// faster than USB charges. Between agent steps, this guard reads the thermal status and battery and
// rests the phone (optionally screen off) until it cools, instead of failing mid-run.

/** Parse `dumpsys thermalservice` (Thermal Status line) and `dumpsys battery` output. */
export function parseHealth(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const temperature = num(/^\s*temperature:\s*(\d+)/m);
  return {
    thermal: num(/Thermal Status:\s*(\d+)/),
    battery: num(/^\s*level:\s*(\d+)/m),
    powered: /(AC|USB|Wireless) powered:\s*true/.test(text),
    ...(temperature !== undefined ? { temperatureC: temperature / 10 } : {}),
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Wrap `device.frame` to time captures and `device.observe` to check health first, at most every
 * `checkMs` or as soon as the median of the last `samples` captures exceeds `maxFrameMs`.
 * Rests while the thermal status is above `maxThermal` (Android: 0 none … 3 severe … 6 shutdown)
 * or a charging battery is below `minBattery`, polling every `pollMs` until the status is at most
 * `resumeThermal`, for up to `maxRestMs`. A low battery that is not charging stops the run.
 * With `screenOff`, the screen sleeps while resting and is woken `wakeMs` before observing again
 * (games reload after waking). Never called mid-routine: observe only runs between actions.
 */
export function withHealthGuard(
  device,
  {
    maxThermal = 2,
    resumeThermal = 1,
    maxFrameMs = 2000,
    samples = 5,
    minBattery = 20,
    checkMs = 60_000,
    pollMs = 60_000,
    maxRestMs = 900_000,
    screenOff = false,
    wakeMs = 30_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => performance.now(),
    onEvent = () => {},
  } = {},
) {
  if (typeof device.health !== 'function') return device;
  const times = [];
  const frame = device.frame?.bind(device);
  if (frame)
    device.frame = async () => {
      const started = now();
      const image = await frame();
      times.push(now() - started);
      if (times.length > samples) times.shift();
      return image;
    };
  const slow = () => times.length >= Math.min(3, samples) && median(times) > maxFrameMs;
  const needsRest = (h) =>
    h.thermal > maxThermal || (h.powered && h.battery !== undefined && h.battery < minBattery);
  const rested = (h) =>
    !(h.thermal > resumeThermal) &&
    !(h.powered && h.battery !== undefined && h.battery < minBattery);
  let lastCheck = -Infinity;
  const check = async () => {
    lastCheck = now();
    const frameMs = times.length ? Math.round(median(times)) : undefined;
    let health = await device.health();
    await onEvent({ event: 'health', ...health, frameMs });
    if (!health.powered && health.battery !== undefined && health.battery < minBattery)
      throw new Error(
        `Phone battery is ${health.battery}% and not charging; connect power before continuing.`,
      );
    if (!needsRest(health)) return;
    const started = now();
    if (screenOff) await device.setScreen(false);
    try {
      do {
        await onEvent({ event: 'rest', ...health, restedMs: Math.round(now() - started) });
        await sleep(pollMs);
        health = await device.health();
      } while (!rested(health) && now() - started < maxRestMs);
    } finally {
      if (screenOff) {
        await device.setScreen(true);
        await sleep(wakeMs);
      }
    }
    times.length = 0;
    await onEvent({
      event: rested(health) ? 'resumed' : 'rest_timeout',
      ...health,
      restedMs: Math.round(now() - started),
    });
  };
  const observe = device.observe.bind(device);
  let acting = 0;
  device.observe = async (...args) => {
    if (!acting && (now() - lastCheck >= checkMs || slow())) await check();
    return observe(...args);
  };
  // Actions observe again for freshness; resting there would only make them stale.
  const act = device.act?.bind(device);
  if (act)
    device.act = async (...args) => {
      acting++;
      try {
        return await act(...args);
      } finally {
        acting--;
      }
    };
  return device;
}
