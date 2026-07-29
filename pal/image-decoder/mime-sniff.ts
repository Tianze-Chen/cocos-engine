/*
 Copyright (c) 2023 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

/**
 * @en Detects the actual image MIME type from the leading bytes of the file.
 * For PNG files, quickly scans for an `acTL` chunk to distinguish APNG from static PNG.
 * @zh 根据文件前导字节检测实际的图片 MIME 类型。
 * 对于 PNG 文件，会快速扫描 `acTL` chunk 以区分 APNG 和静态 PNG。
 *
 * @param bytes The raw file bytes.
 * @param fallback The MIME type to return when the format cannot be determined.
 */
export function sniffMime (bytes: Uint8Array, fallback = 'application/octet-stream'): string {
    if (bytes.length < 8) {
        return fallback;
    }

    // JPEG SOI marker: FF D8
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        return 'image/jpeg';
    }

    // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
        && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return hasAcTL(bytes) ? 'image/apng' : 'image/png';
    }

    return fallback;
}

// Scan PNG chunks for the acTL (animation control) chunk.  We only need to
// read chunk lengths and type codes — no content parsing.  The scan stops at
// the first IDAT or IEND chunk because acTL must appear before IDAT per spec.
function hasAcTL (bytes: Uint8Array): boolean {
    const len = bytes.length;
    // skip the 8-byte PNG signature
    let pos = 8;
    while (pos + 8 <= len) {
        const chunkLen = readU32(bytes, pos);
        const type = readU32(bytes, pos + 4);
        // 'acTL' = 0x6163544C
        if (type === 0x6163544C) {
            return true;
        }
        // 'IDAT' = 0x49444154  or  'IEND' = 0x49454E44
        if (type === 0x49444154 || type === 0x49454E44) {
            return false;
        }
        // length(4) + type(4) + data(chunkLen) + crc(4)
        pos += 12 + chunkLen;
    }
    return false;
}

function readU32 (bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
