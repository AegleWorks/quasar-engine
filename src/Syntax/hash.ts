/**
 * Quasar — Structural Hashing Primitives (FNV-1a)
 *
 * Shared by GreenNode (`_hash`, for interning and structural sharing) and
 * NodeMatcher (subtree fingerprints, for cross-version node matching).
 *
 * FNV-1a is chosen for the same reason Roslyn uses a cheap non-cryptographic
 * hash: this runs once per node on every keystroke, so throughput matters far
 * more than adversarial collision resistance. `Math.imul` keeps the multiply
 * in 32-bit integer space instead of promoting to doubles.
 */

export const FNV_OFFSET = 0x811c9dc5
export const FNV_PRIME = 0x01000193

/** Secondary basis, used to build a 64-bit key from two independent lanes. */
export const FNV_OFFSET_ALT = 0x27d4eb2f

export function hashString(seed: number, str: string): number {
  let h = seed
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return h >>> 0
}

export function hashUint32(seed: number, value: number): number {
  return Math.imul(seed ^ value, FNV_PRIME) >>> 0
}
