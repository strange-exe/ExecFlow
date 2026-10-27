// Reads a response's body with a size cap, so a server that sends too much is refused before it
// fills memory: by its declared length, or while streaming when it declares none (or lies).

export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const tooBig = () => new Error(`the file is larger than ${max} bytes`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) throw tooBig();
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > max) throw tooBig();
    return bytes;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw tooBig();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
