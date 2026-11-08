// Template matching for fixed-size HUD icons (quest markers on the minimap, the tracked quest's
// icon beside its title). A template is a square crop with the icon centred; only the diamond
// |dx| + |dy| <= R around the centre is compared, which covers the quest icons and leaves out
// most of the background in the corners.
//
// The score is a normalised cross-correlation with each colour channel's own mean removed, so a
// flat patch of any tint scores ~0 and the score measures shape and the colour pattern inside it.

/** Prepare a template from a decoded image whose centre pixel is the icon centre. */
export function iconTemplate(image) {
  const R = Math.floor((Math.min(image.width, image.height) - 1) / 2);
  const cx = Math.floor(image.width / 2),
    cy = Math.floor(image.height / 2);
  const off = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) if (Math.abs(dx) + Math.abs(dy) <= R) off.push([dx, dy]);
  const n = off.length,
    v = new Float64Array(n * 3),
    mean = [0, 0, 0];
  off.forEach(([dx, dy], k) => {
    const i = ((cy + dy) * image.width + cx + dx) * image.channels;
    for (let c = 0; c < 3; c++) {
      v[k * 3 + c] = image.pixels[i + c];
      mean[c] += image.pixels[i + c] / n;
    }
  });
  let ss = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean[i % 3];
    ss += v[i] ** 2;
  }
  return { R, off, v, norm: Math.sqrt(ss), mean };
}

/**
 * Score of template `t` centred at image pixel (x, y), drawn `k` image pixels per template pixel.
 * With `maxColor`, a patch whose mean colour is further than that from the template's scores 0.
 * The patch is first brightened (up to 2.5x) to the template's brightness: the minimap darkens
 * icons near its rim and the whole HUD dims during transitions, which keeps the hue.
 */
export function iconScore(image, x, y, t, k = 1, maxColor = Infinity) {
  const { off, v } = t,
    n = off.length,
    { width, height, channels, pixels } = image;
  if (
    x - t.R * k < 0 ||
    y - t.R * k < 0 ||
    Math.round(x + t.R * k) >= width ||
    Math.round(y + t.R * k) >= height
  )
    return 0;
  const s = [0, 0, 0],
    s2 = [0, 0, 0];
  let sv = 0;
  for (let j = 0; j < n; j++) {
    const i = (Math.round(y + off[j][1] * k) * width + Math.round(x + off[j][0] * k)) * channels;
    for (let c = 0; c < 3; c++) {
      const p = pixels[i + c];
      s[c] += p;
      s2[c] += p * p;
      sv += p * v[j * 3 + c];
    }
  }
  const m = s.map((q) => q / n);
  const gain = Math.min(2.5, Math.max(1, Math.hypot(...t.mean) / Math.max(1, Math.hypot(...m))));
  if (
    Math.hypot(m[0] * gain - t.mean[0], m[1] * gain - t.mean[1], m[2] * gain - t.mean[2]) > maxColor
  )
    return 0;
  let varp = 0;
  for (let c = 0; c < 3; c++) varp += s2[c] - (s[c] * s[c]) / n;
  return varp <= 1 ? 0 : sv / (Math.sqrt(varp) * t.norm);
}

/** Best score of `t` within `search` image px of (x, y). */
export function bestIconAt(image, x, y, t, { k = 1, search = 3, maxColor } = {}) {
  let best = { s: 0, x, y };
  for (let yy = Math.round(y - search); yy <= y + search; yy++)
    for (let xx = Math.round(x - search); xx <= x + search; xx++) {
      const s = iconScore(image, xx, yy, t, k, maxColor);
      if (s > best.s) best = { s, x: xx, y: yy };
    }
  return best;
}

/**
 * Every place within `radius` image px of (cx, cy) where one of `templates` scores at least
 * `threshold`, best first, one per icon (hits closer than the icon size are merged). Positions
 * whose centre pixel is grey (chroma below `minChroma`) are skipped: quest icons are saturated.
 */
export function findIcons(
  image,
  { cx, cy, radius },
  templates,
  { k = 1, threshold = 0.65, maxColor = 60, minChroma = 40, step = 1 } = {},
) {
  const { width, height, channels, pixels } = image;
  const hits = [];
  const R = Math.max(...templates.map((t) => t.R)) * k;
  for (
    let y = Math.max(0, Math.round(cy - radius));
    y <= Math.min(height - 1, cy + radius);
    y += step
  )
    for (
      let x = Math.max(0, Math.round(cx - radius));
      x <= Math.min(width - 1, cx + radius);
      x += step
    ) {
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const i = (y * width + x) * channels;
      const r = pixels[i],
        g = pixels[i + 1],
        b = pixels[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) < minChroma) continue;
      for (const t of templates) {
        const s = iconScore(image, x, y, t, k, maxColor);
        if (s >= threshold * 0.9) hits.push({ s, x, y, t });
      }
    }
  hits.sort((a, b) => b.s - a.s);
  const icons = [];
  for (const h of hits) {
    if (icons.some((o) => Math.hypot(o.x - h.x, o.y - h.y) < R)) continue;
    const fine = bestIconAt(image, h.x, h.y, h.t, { k, search: Math.ceil(step / 2), maxColor });
    if (fine.s >= threshold) icons.push(fine);
  }
  return icons.sort((a, b) => b.s - a.s);
}
