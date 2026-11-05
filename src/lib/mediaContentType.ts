import fs from 'node:fs';

/** Determine the response type from decrypted bytes instead of a misleading filename. */
export function mediaContentType(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString('ascii') === 'PNG'
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'qt  ') return 'video/quicktime';
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    return 'video/mp4';
  }
  return 'application/octet-stream';
}

/** Read only the file signature; large uploads must never be loaded just to detect their type. */
export function mediaContentTypeForFile(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const signature = Buffer.alloc(32);
    const bytesRead = fs.readSync(fd, signature, 0, signature.length, 0);
    return mediaContentType(signature.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}
