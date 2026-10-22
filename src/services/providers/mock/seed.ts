/**
 * 32-bit FNV-1a followed by the murmur3 finalizer. FNV alone distributes
 * inputs that differ only in their last characters (such as consecutive
 * dates) poorly; the finalizer spreads every input bit over the output.
 */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Deterministic value in [0, 1) derived from the given parts. */
export function unitHash(...parts: string[]): number {
  return hash32(parts.join("|")) / 0x1_0000_0000;
}

export function isWeekend(day: Date): boolean {
  const dow = day.getUTCDay();
  return dow === 0 || dow === 6;
}
