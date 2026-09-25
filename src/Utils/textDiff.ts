/**
 * The one region where two texts differ: the length of their common prefix,
 * and where their common suffix starts in each — the scan
 * `DocumentModel.applyTextUpdate` and `Anchors/diffText` both run on every
 * keystroke.
 *
 * Char by char, that scan read the whole document twice per key: 1.1 ms on the
 * 547 KB fixture, more than everything else a keystroke does. Whole blocks are
 * compared first, as slices (`===` on two slices of flat strings is a native
 * memory comparison), shrinking the block size as they stop matching, and
 * only the last stretch is walked char by char: 0.04 ms. The answer is the
 * same by construction — a block advances only when it matches entirely, so
 * neither scan can step over the first difference.
 *
 * `suffixStart*` never cross `prefix`: the suffix is measured on what is left.
 */
export function commonPrefixSuffix(a: string, b: string): { prefix: number; suffixStartA: number; suffixStartB: number } {
  const shared = a.length < b.length ? a.length : b.length
  let prefix = 0
  for (let block = 16384; block >= 32; block >>= 2) {
    while (prefix + block <= shared && a.slice(prefix, prefix + block) === b.slice(prefix, prefix + block)) prefix += block
  }
  while (prefix < shared && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++

  let endA = a.length
  let endB = b.length
  for (let block = 16384; block >= 32; block >>= 2) {
    while (endA - block >= prefix && endB - block >= prefix && a.slice(endA - block, endA) === b.slice(endB - block, endB)) {
      endA -= block
      endB -= block
    }
  }
  while (endA > prefix && endB > prefix && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { prefix, suffixStartA: endA, suffixStartB: endB }
}
