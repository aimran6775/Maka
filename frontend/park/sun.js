// Sun position from the real clock. Cosmetic: the time of day never encodes harness state.
// Returns a direction (unit vector, y up) and a light colour/intensity for the hour.

export function sunFor(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  // Sunrise ~6h, noon 12h, sunset ~18h. Elevation follows a cosine over the day.
  const dayT = (h - 6) / 12; // 0 at sunrise, 1 at sunset
  const elevation = Math.sin(Math.PI * Math.min(1, Math.max(0, dayT))); // 0..1..0 by day
  const azimuth = Math.PI * (0.15 + 0.7 * Math.min(1, Math.max(0, dayT))); // east to west
  const night = dayT < 0 || dayT > 1;
  const y = night ? -0.2 : 0.15 + 0.85 * elevation;
  const dir = { x: Math.cos(azimuth), y, z: Math.sin(azimuth) * 0.6 };
  const len = Math.hypot(dir.x, dir.y, dir.z);
  // How far through the warm end of the day the sun is: nothing at noon, rising only as
  // it nears the horizon. A ramp, not a switch — a flag flipped at a fixed elevation
  // turns the park orange for whole hours of the afternoon, which no daylight does.
  const warmth = night ? 0 : Math.min(1, Math.max(0, (0.4 - elevation) / 0.4)) ** 1.5;
  return {
    direction: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
    intensity: night ? 0.08 : 0.6 + 1.6 * elevation,
    color: night ? 0x334466 : mix(0xfff2dc, 0xffc07a, warmth),
    // `sky` and `fog` are the horizon band, which goes warm at dawn and dusk. `zenith`
    // is the dome overhead, which stays blue: a sky painted warm from the ground to
    // straight up is the one thing golden hour does not do.
    sky: night ? 0x0b1630 : mix(0x86b8d9, 0xe8a87c, warmth),
    zenith: night ? 0x070d1c : mix(0x4f87c4, 0x6f93bd, warmth),
    fog: night ? 0x101a2e : mix(0xbcd6e8, 0xcfbaa6, warmth),
    ambient: night ? 0.25 : 0.35 + 0.3 * elevation,
    warmth,
    night,
  };
}

// Two packed sRGB colours mixed channel by channel.
function mix(a, b, t) {
  const ch = (shift) => {
    const av = (a >> shift) & 255;
    const bv = (b >> shift) & 255;
    return Math.round(av + (bv - av) * t) & 255;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
