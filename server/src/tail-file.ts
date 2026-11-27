import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

export function readTailLines(filePath: string, maxLines: number, maxBytes = 128 * 1024): string[] {
  if (!existsSync(filePath)) return [];
  const fd = openSync(filePath, 'r');
  try {
    const st = fstatSync(fd);
    if (st.size === 0) return [];
    const readLen = Math.min(st.size, maxBytes);
    const startPos = st.size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    let offset = 0;
    while (offset < readLen) {
      const bytesRead = readSync(fd, buf, offset, readLen - offset, startPos + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (startPos > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}
