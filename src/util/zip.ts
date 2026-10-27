// Zip
// ===
// A zip's file by name, read without the rest.

// a zip's file by name (at any depth), read without the rest: its entry
// in the central directory at the zip's end, then its data, inflated
// (DecompressionStream) if deflated; null: none such. A ZIP64 (over 4 GB,
// or 65,535 files) says where its directory is in its own end record,
// found by the locator right before the classic one
export async function zip_file(zip: Blob, name: string): Promise<Blob | null> {
  const view = async (at: number, n: number) =>
    new DataView(await zip.slice(at, at + n).arrayBuffer())
  const back = Math.min(zip.size, 65577)
  const tail = await view(zip.size - back, back)
  let end = tail.byteLength - 22
  while (end >= 0 && tail.getUint32(end, true) !== 0x06054b50) {
    end -= 1
  }
  if (end < 0) {
    return null
  }
  const wide = end >= 20 && tail.getUint32(end - 20, true) === 0x07064b50
  const z64 = wide
    ? await view(Number(tail.getBigUint64(end - 12, true)), 56)
    : null
  const count =
    z64 === null
      ? tail.getUint16(end + 10, true)
      : Number(z64.getBigUint64(32, true))
  const size =
    z64 === null
      ? tail.getUint32(end + 12, true)
      : Number(z64.getBigUint64(40, true))
  const from =
    z64 === null
      ? tail.getUint32(end + 16, true)
      : Number(z64.getBigUint64(48, true))
  const dir = await view(from, size)
  for (let p = 0, k = 0; k < count; k++) {
    const entry = new TextDecoder().decode(
      new Uint8Array(dir.buffer, p + 46, dir.getUint16(p + 28, true))
    )
    const [, packed, at] = zip_sizes(dir, p)
    if (entry === name || entry.endsWith("/" + name)) {
      const head = await view(at, 30)
      const data = zip
        .slice(at + 30 + head.getUint16(26, true) + head.getUint16(28, true))
        .slice(0, packed)
      return dir.getUint16(p + 10, true) === 8
        ? new Response(
            data.stream().pipeThrough(new DecompressionStream("deflate-raw"))
          ).blob()
        : data
    }
    p +=
      46 +
      dir.getUint16(p + 28, true) +
      dir.getUint16(p + 30, true) +
      dir.getUint16(p + 32, true)
  }
  return null
}

// a directory entry's size, size packed and local header's place, each
// as its 32 bits say; one too large for them reads 0xFFFFFFFF, its value
// in the entry's ZIP64 extra field (id 1), which holds only those, in
// this order
function zip_sizes(dir: DataView, p: number): number[] {
  const short = [p + 24, p + 20, p + 42].map((at) => dir.getUint32(at, true))
  const extra = p + 46 + dir.getUint16(p + 28, true)
  let x = extra
  while (
    x + 4 <= extra + dir.getUint16(p + 30, true) &&
    dir.getUint16(x, true) !== 1
  ) {
    x += 4 + dir.getUint16(x + 2, true)
  }
  let k = 0
  return short.map((n) =>
    n === 0xffffffff ? Number(dir.getBigUint64(x + 4 + 8 * k++, true)) : n
  )
}
