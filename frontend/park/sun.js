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
  const warm = !night && elevation < 0.35; // dawn / dusk
  return {
    direction: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
    intensity: night ? 0.08 : 0.6 + 1.6 * elevation,
    color: night ? 0x334466 : warm ? 0xffb070 : 0xfff2dc,
    sky: night ? 0x0b1630 : warm ? 0xf0a070 : 0x86b8d9,
    fog: night ? 0x101a2e : warm ? 0xd9b090 : 0xbcd6e8,
    ambient: night ? 0.25 : 0.35 + 0.3 * elevation,
    night,
  };
}
