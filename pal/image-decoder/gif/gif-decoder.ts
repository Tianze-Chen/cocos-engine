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

import type { IAnimatedImageDecoder, IDecodedFrame } from '../type';

// GIF disposal methods
const DISPOSE_NONE = 0;
const DISPOSE_BACKGROUND = 2;
const DISPOSE_PREVIOUS = 3;

interface GifFrameInfo {
    left: number;
    top: number;
    width: number;
    height: number;
    localColorTable: Uint8Array | null;
    interlaced: boolean;
    // from Graphics Control Extension
    disposalMethod: number;
    transparentIndex: number; // -1 if none
    delay: number; // milliseconds
    lzwMinCodeSize: number;
    dataBlocks: Uint8Array[];
}

class GifDecoder implements IAnimatedImageDecoder {
    public readonly width: number;
    public readonly height: number;
    public readonly frameCount: number;
    public readonly loopCount: number;
    private _frames: IDecodedFrame[];

    constructor (width: number, height: number, loopCount: number, frames: IDecodedFrame[]) {
        this.width = width;
        this.height = height;
        this.frameCount = frames.length;
        this.loopCount = loopCount;
        this._frames = frames;
    }

    public decodeFrame (index: number): Promise<IDecodedFrame> {
        if (index < 0 || index >= this._frames.length) {
            return Promise.reject(new Error(`frame index ${index} out of range [0, ${this._frames.length})`));
        }
        return Promise.resolve(this._frames[index]);
    }

    public destroy (): void {
        this._frames = [];
    }
}

/**
 * @en Creates an animated GIF decoder. Decodes all frames eagerly.
 * @zh 创建动画 GIF 解码器。一次性解码所有帧。
 */
export function createGifDecoder (bytes: Uint8Array): IAnimatedImageDecoder {
    const parser = new GifParser(bytes);
    parser.parse();
    const composited = compositeFrames(parser);
    return new GifDecoder(parser.width, parser.height, parser.loopCount, composited);
}

// ----- GIF binary parser -----

class GifParser {
    public width = 0;
    public height = 0;
    public loopCount = 0;
    public globalColorTable: Uint8Array | null = null;
    public bgColorIndex = 0;
    public frames: GifFrameInfo[] = [];

    private _data: Uint8Array;
    private _pos = 0;

    // pending GCE values for the next frame
    private _gceDisposal = 0;
    private _gceTransparent = -1;
    private _gceDelay = 0;

    constructor (data: Uint8Array) {
        this._data = data;
    }

    public parse (): void {
        this._parseHeader();
        this._parseLogicalScreenDescriptor();
        this._parseBlocks();
    }

    private _parseHeader (): void {
        // Skip "GIF87a" or "GIF89a" (6 bytes)
        this._pos = 6;
    }

    private _parseLogicalScreenDescriptor (): void {
        this.width = this._readU16();
        this.height = this._readU16();
        const packed = this._data[this._pos++];
        this.bgColorIndex = this._data[this._pos++];
        this._pos++; // pixel aspect ratio (ignored)

        const hasGCT = (packed & 0x80) !== 0;
        const gctSize = 1 << ((packed & 0x07) + 1);
        if (hasGCT) {
            this.globalColorTable = this._readBytes(gctSize * 3);
        }
    }

    private _parseBlocks (): void {
        const data = this._data;
        while (this._pos < data.length) {
            const introducer = data[this._pos++];
            switch (introducer) {
            case 0x2C: // Image Descriptor
                this._parseImageDescriptor();
                break;
            case 0x21: // Extension
                this._parseExtension();
                break;
            case 0x3B: // Trailer
                return;
            default:
                // unknown block, stop
                return;
            }
        }
    }

    private _parseExtension (): void {
        const label = this._data[this._pos++];
        switch (label) {
        case 0xF9: // Graphics Control Extension
            this._parseGCE();
            break;
        case 0xFF: // Application Extension (NETSCAPE for loop count)
            this._parseApplicationExtension();
            break;
        default:
            this._skipSubBlocks();
            break;
        }
    }

    private _parseGCE (): void {
        this._pos++; // block size (always 4)
        const packed = this._data[this._pos++];
        this._gceDisposal = (packed >>> 2) & 0x07;
        const hasTransparency = (packed & 0x01) !== 0;
        this._gceDelay = this._readU16() * 10; // centiseconds → ms
        const transparentIndex = this._data[this._pos++];
        this._gceTransparent = hasTransparency ? transparentIndex : -1;
        this._pos++; // block terminator
    }

    private _parseApplicationExtension (): void {
        const blockSize = this._data[this._pos++];
        // check for NETSCAPE2.0
        if (blockSize === 11) {
            const id = String.fromCharCode(
                this._data[this._pos], this._data[this._pos + 1], this._data[this._pos + 2],
                this._data[this._pos + 3], this._data[this._pos + 4], this._data[this._pos + 5],
                this._data[this._pos + 6], this._data[this._pos + 7],
                this._data[this._pos + 8], this._data[this._pos + 9], this._data[this._pos + 10],
            );
            this._pos += 11;
            if (id === 'NETSCAPE2.0') {
                const subBlockSize = this._data[this._pos++];
                if (subBlockSize === 3 && this._data[this._pos] === 1) {
                    this._pos++; // sub-block id
                    this.loopCount = this._readU16(); // 0 = infinite
                    this._pos++; // block terminator
                    return;
                }
                this._pos--; // didn't match, rewind
            }
        } else {
            this._pos += blockSize;
        }
        this._skipSubBlocks();
    }

    private _parseImageDescriptor (): void {
        const left = this._readU16();
        const top = this._readU16();
        const width = this._readU16();
        const height = this._readU16();
        const packed = this._data[this._pos++];
        const hasLocalCT = (packed & 0x80) !== 0;
        const interlaced = (packed & 0x40) !== 0;
        const lctSize = 1 << ((packed & 0x07) + 1);

        let localColorTable: Uint8Array | null = null;
        if (hasLocalCT) {
            localColorTable = this._readBytes(lctSize * 3);
        }

        const lzwMinCodeSize = this._data[this._pos++];
        const dataBlocks = this._collectSubBlocks();

        const frame: GifFrameInfo = {
            left,
            top,
            width,
            height,
            localColorTable,
            interlaced,
            disposalMethod: this._gceDisposal,
            transparentIndex: this._gceTransparent,
            delay: this._gceDelay || 100, // default 100ms if 0
            lzwMinCodeSize,
            dataBlocks,
        };

        this.frames.push(frame);

        // reset GCE for next frame
        this._gceDisposal = 0;
        this._gceTransparent = -1;
        this._gceDelay = 0;
    }

    private _collectSubBlocks (): Uint8Array[] {
        const blocks: Uint8Array[] = [];
        while (true) {
            const size = this._data[this._pos++];
            if (size === 0) break;
            blocks.push(this._data.subarray(this._pos, this._pos + size));
            this._pos += size;
        }
        return blocks;
    }

    private _skipSubBlocks (): void {
        while (true) {
            const size = this._data[this._pos++];
            if (size === 0) break;
            this._pos += size;
        }
    }

    private _readU16 (): number {
        const val = this._data[this._pos] | (this._data[this._pos + 1] << 8);
        this._pos += 2;
        return val;
    }

    private _readBytes (count: number): Uint8Array {
        const result = new Uint8Array(count);
        result.set(this._data.subarray(this._pos, this._pos + count));
        this._pos += count;
        return result;
    }
}

// ----- LZW decompression -----

function lzwDecode (minCodeSize: number, blocks: Uint8Array[], pixelCount: number): Uint8Array {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;
    let nextCode = eoiCode + 1;
    const maxTableSize = 4096;

    // code table: each entry is [prefix code, suffix byte]
    // for codes < clearCode, the entry is just the byte itself
    const table: (Uint8Array | null)[] = new Array(maxTableSize);
    for (let i = 0; i < clearCode; i++) {
        table[i] = new Uint8Array([i]);
    }

    const output = new Uint8Array(pixelCount);
    let outPos = 0;

    // bit reader state
    let blockIdx = 0;
    let byteIdx = 0;
    let bitBuf = 0;
    let bitsAvail = 0;

    function readCode (): number {
        while (bitsAvail < codeSize) {
            if (blockIdx < blocks.length && byteIdx < blocks[blockIdx].length) {
                bitBuf |= blocks[blockIdx][byteIdx++] << bitsAvail;
                bitsAvail += 8;
                if (byteIdx >= blocks[blockIdx].length) {
                    blockIdx++;
                    byteIdx = 0;
                }
            } else {
                return eoiCode;
            }
        }
        const code = bitBuf & codeMask;
        bitBuf >>>= codeSize;
        bitsAvail -= codeSize;
        return code;
    }

    function resetTable (): void {
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        nextCode = eoiCode + 1;
        for (let i = eoiCode + 1; i < maxTableSize; i++) {
            table[i] = null;
        }
    }

    // skip initial clear code
    let code = readCode();
    if (code === clearCode) {
        resetTable();
        code = readCode();
    }
    if (code === eoiCode || code >= nextCode) {
        return output;
    }

    let prev = table[code]!;
    for (let i = 0; i < prev.length && outPos < pixelCount; i++) {
        output[outPos++] = prev[i];
    }

    while (outPos < pixelCount) {
        code = readCode();
        if (code === eoiCode) break;
        if (code === clearCode) {
            resetTable();
            code = readCode();
            if (code === eoiCode) break;
            prev = table[code]!;
            for (let i = 0; i < prev.length && outPos < pixelCount; i++) {
                output[outPos++] = prev[i];
            }
            continue;
        }

        let entry: Uint8Array;
        if (code < nextCode && table[code] !== null) {
            entry = table[code]!;
        } else if (code === nextCode) {
            // special case: code not in table yet
            entry = new Uint8Array(prev.length + 1);
            entry.set(prev);
            entry[prev.length] = prev[0];
        } else {
            // invalid code, stop
            break;
        }

        for (let i = 0; i < entry.length && outPos < pixelCount; i++) {
            output[outPos++] = entry[i];
        }

        if (nextCode < maxTableSize) {
            const newEntry = new Uint8Array(prev.length + 1);
            newEntry.set(prev);
            newEntry[prev.length] = entry[0];
            table[nextCode++] = newEntry;

            if (nextCode > codeMask && codeSize < 12) {
                codeSize++;
                codeMask = (1 << codeSize) - 1;
            }
        }

        prev = entry;
    }

    return output;
}

// ----- de-interlace -----

function deinterlace (pixels: Uint8Array, width: number, height: number): Uint8Array {
    const result = new Uint8Array(pixels.length);
    // GIF interlace pass offsets and steps
    const offsets = [0, 4, 2, 1];
    const steps = [8, 8, 4, 2];
    let srcRow = 0;
    for (let pass = 0; pass < 4; pass++) {
        for (let y = offsets[pass]; y < height; y += steps[pass]) {
            const srcOff = srcRow * width;
            const dstOff = y * width;
            result.set(pixels.subarray(srcOff, srcOff + width), dstOff);
            srcRow++;
        }
    }
    return result;
}

// ----- frame compositing -----

function compositeFrames (parser: GifParser): IDecodedFrame[] {
    const { width, height, frames, globalColorTable, bgColorIndex } = parser;
    const pixelCount = width * height;
    // the "canvas" — current composited RGBA buffer
    const canvas = new Uint8Array(pixelCount * 4);
    // previous canvas for DISPOSE_PREVIOUS
    let previousCanvas: Uint8Array | null = null;

    const result: IDecodedFrame[] = new Array(frames.length);

    for (let f = 0; f < frames.length; f++) {
        const frame = frames[f];
        const colorTable = frame.localColorTable || globalColorTable;
        if (!colorTable) {
            throw new Error('GIF frame has no color table');
        }

        // save canvas before rendering if disposal is "restore to previous"
        if (frame.disposalMethod === DISPOSE_PREVIOUS) {
            previousCanvas = new Uint8Array(canvas);
        }

        // decode LZW data to indexed pixels
        let indexedPixels = lzwDecode(frame.lzwMinCodeSize, frame.dataBlocks, frame.width * frame.height);
        if (frame.interlaced) {
            indexedPixels = deinterlace(indexedPixels, frame.width, frame.height);
        }

        // paint onto canvas
        for (let y = 0; y < frame.height; y++) {
            for (let x = 0; x < frame.width; x++) {
                const srcIdx = y * frame.width + x;
                const colorIdx = indexedPixels[srcIdx];
                if (colorIdx === frame.transparentIndex) continue;

                const cx = frame.left + x;
                const cy = frame.top + y;
                if (cx >= width || cy >= height) continue;

                const dstIdx = (cy * width + cx) * 4;
                const ci = colorIdx * 3;
                canvas[dstIdx] = colorTable[ci];
                canvas[dstIdx + 1] = colorTable[ci + 1];
                canvas[dstIdx + 2] = colorTable[ci + 2];
                canvas[dstIdx + 3] = 255;
            }
        }

        // snapshot the composited frame
        result[f] = {
            data: new Uint8Array(canvas),
            duration: frame.delay,
        };

        // apply disposal
        switch (frame.disposalMethod) {
        case DISPOSE_BACKGROUND:
            for (let y = 0; y < frame.height; y++) {
                for (let x = 0; x < frame.width; x++) {
                    const cx = frame.left + x;
                    const cy = frame.top + y;
                    if (cx >= width || cy >= height) continue;
                    const dstIdx = (cy * width + cx) * 4;
                    canvas[dstIdx] = 0;
                    canvas[dstIdx + 1] = 0;
                    canvas[dstIdx + 2] = 0;
                    canvas[dstIdx + 3] = 0;
                }
            }
            break;
        case DISPOSE_PREVIOUS:
            if (previousCanvas) {
                canvas.set(previousCanvas);
            }
            break;
        // DISPOSE_NONE (0, 1): leave canvas as-is
        }
    }

    return result;
}
