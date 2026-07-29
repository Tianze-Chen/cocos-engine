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
import zlib from '../../../external/compression/zlib.min';

// APNG dispose operations (fcTL)
const DISPOSE_NONE = 0;
const DISPOSE_BACKGROUND = 1;
const DISPOSE_PREVIOUS = 2;

// APNG blend operations (fcTL)
const BLEND_SOURCE = 0;
const BLEND_OVER = 1;

// PNG color types
const COLOR_GRAYSCALE = 0;
const COLOR_RGB = 2;
const COLOR_INDEXED = 3;
const COLOR_GRAYSCALE_ALPHA = 4;
const COLOR_RGBA = 6;

interface IhdrInfo {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
}

interface FrameControl {
    width: number;
    height: number;
    xOffset: number;
    yOffset: number;
    delayNum: number;
    delayDen: number;
    disposeOp: number;
    blendOp: number;
}

interface RawFrame {
    fcTL: FrameControl;
    data: Uint8Array; // concatenated compressed data (IDAT or fdAT payloads)
}

class ApngDecoder implements IAnimatedImageDecoder {
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
 * @en Creates an animated PNG (APNG) decoder. Decodes all frames eagerly.
 * @zh 创建动画 PNG (APNG) 解码器。一次性解码所有帧。
 */
export function createApngDecoder (bytes: Uint8Array): IAnimatedImageDecoder {
    const parsed = parsePng(bytes);
    if (parsed.rawFrames.length > 0) {
        console.log(`[APNG] frames=${parsed.rawFrames.length}, loopCount=${parsed.loopCount}`);
        for (let i = 0; i < parsed.rawFrames.length; i++) {
            const fc = parsed.rawFrames[i].fcTL;
            console.log(`  frame ${i}: ${fc.width}x${fc.height}+${fc.xOffset}+${fc.yOffset} dispose=${fc.disposeOp} blend=${fc.blendOp} delay=${fc.delayNum}/${fc.delayDen}`);
        }
    }
    const composited = compositeFrames(parsed.ihdr, parsed.rawFrames, parsed.palette, parsed.transparency);
    return new ApngDecoder(parsed.ihdr.width, parsed.ihdr.height, parsed.loopCount, composited);
}

// ----- PNG binary parser -----

interface ParsedPng {
    ihdr: IhdrInfo;
    loopCount: number;
    rawFrames: RawFrame[];
    palette: Uint8Array | null;
    transparency: Uint8Array | null;
}

function parsePng (data: Uint8Array): ParsedPng {
    let pos = 8; // skip PNG signature
    let ihdr: IhdrInfo | null = null;
    let loopCount = 0;
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;

    const rawFrames: RawFrame[] = [];
    let currentFcTL: FrameControl | null = null;
    let currentDataChunks: Uint8Array[] = [];
    // tracks whether the default image (IDAT) is part of the animation
    let idatIsFirstFrame = false;
    let idatChunks: Uint8Array[] = [];
    let seenFcTLBeforeIDAT = false;

    while (pos + 8 <= data.length) {
        const chunkLen = readU32(data, pos);
        const chunkType = readChunkType(data, pos + 4);
        const chunkDataStart = pos + 8;

        switch (chunkType) {
        case 'IHDR':
            ihdr = {
                width: readU32(data, chunkDataStart),
                height: readU32(data, chunkDataStart + 4),
                bitDepth: data[chunkDataStart + 8],
                colorType: data[chunkDataStart + 9],
            };
            break;

        case 'acTL':
            // numFrames at offset 0, numPlays at offset 4
            loopCount = readU32(data, chunkDataStart + 4);
            break;

        case 'fcTL': {
            // if we had a previous fcTL with collected data, finalize it
            if (currentFcTL && currentDataChunks.length > 0) {
                rawFrames.push({ fcTL: currentFcTL, data: concatBytes(currentDataChunks) });
                currentDataChunks = [];
            }
            // sequence_number(4) then frame control fields
            const off = chunkDataStart + 4;
            currentFcTL = {
                width: readU32(data, off),
                height: readU32(data, off + 4),
                xOffset: readU32(data, off + 8),
                yOffset: readU32(data, off + 12),
                delayNum: readU16(data, off + 16),
                delayDen: readU16(data, off + 18),
                disposeOp: data[off + 20],
                blendOp: data[off + 21],
            };
            if (idatChunks.length === 0) {
                seenFcTLBeforeIDAT = true;
            }
            break;
        }

        case 'IDAT':
            idatChunks.push(data.subarray(chunkDataStart, chunkDataStart + chunkLen));
            if (seenFcTLBeforeIDAT) {
                // IDAT belongs to the first animation frame
                currentDataChunks.push(data.subarray(chunkDataStart, chunkDataStart + chunkLen));
                idatIsFirstFrame = true;
            }
            break;

        case 'fdAT':
            // skip sequence_number (4 bytes)
            currentDataChunks.push(data.subarray(chunkDataStart + 4, chunkDataStart + chunkLen));
            break;

        case 'PLTE':
            palette = new Uint8Array(data.subarray(chunkDataStart, chunkDataStart + chunkLen));
            break;

        case 'tRNS':
            transparency = new Uint8Array(data.subarray(chunkDataStart, chunkDataStart + chunkLen));
            break;

        case 'IEND':
            // finalize last frame
            if (currentFcTL && currentDataChunks.length > 0) {
                rawFrames.push({ fcTL: currentFcTL, data: concatBytes(currentDataChunks) });
            }
            break;
        }

        // length(4) + type(4) + data(chunkLen) + crc(4)
        pos += 12 + chunkLen;
    }

    if (!ihdr) {
        throw new Error('APNG: missing IHDR chunk');
    }

    // if no fcTL appeared before IDAT, the default image is not part of the animation;
    // in that case, rawFrames should already be correct (only fdAT-based frames).
    // if fcTL appeared before IDAT but we didn't add IDAT data because the flag wasn't set
    // in time, that case is already handled above.

    return { ihdr, loopCount, rawFrames, palette, transparency };
}

// ----- pixel decoding -----

function inflateData (compressed: Uint8Array): Uint8Array {
    const inflate = new zlib.Inflate(compressed, { index: 0, verify: false });
    return inflate.decompress() as Uint8Array;
}

function decodePixels (
    compressed: Uint8Array,
    width: number,
    height: number,
    ihdr: IhdrInfo,
    palette: Uint8Array | null,
    transparency: Uint8Array | null,
): Uint8Array {
    const raw = inflateData(compressed);

    // calculate bytes per pixel for the filter step
    const bpp = bytesPerPixel(ihdr);
    const scanlineBytes = width * bpp;
    const filtered = new Uint8Array(scanlineBytes * height);

    // apply PNG row filters
    let srcPos = 0;
    let dstPos = 0;
    for (let row = 0; row < height; row++) {
        const filter = raw[srcPos++];
        for (let i = 0; i < scanlineBytes; i++) {
            const curByte = raw[srcPos++];
            const left = i < bpp ? 0 : filtered[dstPos - bpp];
            const up = row === 0 ? 0 : filtered[dstPos - scanlineBytes];
            const upLeft = (row === 0 || i < bpp) ? 0 : filtered[dstPos - scanlineBytes - bpp];

            switch (filter) {
            case 0: // None
                filtered[dstPos] = curByte;
                break;
            case 1: // Sub
                filtered[dstPos] = (curByte + left) & 0xFF;
                break;
            case 2: // Up
                filtered[dstPos] = (curByte + up) & 0xFF;
                break;
            case 3: // Average
                filtered[dstPos] = (curByte + ((left + up) >>> 1)) & 0xFF;
                break;
            case 4: // Paeth
                filtered[dstPos] = (curByte + paethPredictor(left, up, upLeft)) & 0xFF;
                break;
            }
            dstPos++;
        }
    }

    // convert to RGBA8888
    return toRGBA(filtered, width, height, ihdr, palette, transparency);
}

function bytesPerPixel (ihdr: IhdrInfo): number {
    switch (ihdr.colorType) {
    case COLOR_GRAYSCALE: return Math.max(1, ihdr.bitDepth / 8);
    case COLOR_RGB: return 3 * (ihdr.bitDepth / 8);
    case COLOR_INDEXED: return 1; // 8-bit or less per sample, but after filter always 1 byte per pixel for 8-bit
    case COLOR_GRAYSCALE_ALPHA: return 2 * (ihdr.bitDepth / 8);
    case COLOR_RGBA: return 4 * (ihdr.bitDepth / 8);
    default: return 4;
    }
}

function paethPredictor (a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function toRGBA (
    pixels: Uint8Array,
    width: number,
    height: number,
    ihdr: IhdrInfo,
    palette: Uint8Array | null,
    transparency: Uint8Array | null,
): Uint8Array {
    const total = width * height;
    const rgba = new Uint8Array(total * 4);

    switch (ihdr.colorType) {
    case COLOR_GRAYSCALE: {
        // transparency for grayscale: 2 bytes representing the gray value to be transparent
        const transGray = transparency && transparency.length >= 2
            ? ((transparency[0] << 8) | transparency[1]) : -1;
        for (let i = 0; i < total; i++) {
            const v = pixels[i];
            rgba[i * 4] = v;
            rgba[i * 4 + 1] = v;
            rgba[i * 4 + 2] = v;
            rgba[i * 4 + 3] = v === transGray ? 0 : 255;
        }
        break;
    }
    case COLOR_RGB: {
        // transparency for RGB: 6 bytes (R,G,B each as 2-byte values)
        let transR = -1; let transG = -1; let transB = -1;
        if (transparency && transparency.length >= 6) {
            transR = (transparency[0] << 8) | transparency[1];
            transG = (transparency[2] << 8) | transparency[3];
            transB = (transparency[4] << 8) | transparency[5];
        }
        for (let i = 0; i < total; i++) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];
            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = (r === transR && g === transG && b === transB) ? 0 : 255;
        }
        break;
    }
    case COLOR_INDEXED: {
        if (!palette) {
            throw new Error('APNG: indexed color but no PLTE chunk');
        }
        for (let i = 0; i < total; i++) {
            const idx = pixels[i];
            rgba[i * 4] = palette[idx * 3];
            rgba[i * 4 + 1] = palette[idx * 3 + 1];
            rgba[i * 4 + 2] = palette[idx * 3 + 2];
            rgba[i * 4 + 3] = (transparency && idx < transparency.length) ? transparency[idx] : 255;
        }
        break;
    }
    case COLOR_GRAYSCALE_ALPHA:
        for (let i = 0; i < total; i++) {
            const v = pixels[i * 2];
            rgba[i * 4] = v;
            rgba[i * 4 + 1] = v;
            rgba[i * 4 + 2] = v;
            rgba[i * 4 + 3] = pixels[i * 2 + 1];
        }
        break;
    case COLOR_RGBA:
        rgba.set(pixels);
        break;
    }
    return rgba;
}

// ----- frame compositing -----

function compositeFrames (
    ihdr: IhdrInfo,
    rawFrames: RawFrame[],
    palette: Uint8Array | null,
    transparency: Uint8Array | null,
): IDecodedFrame[] {
    const canvasWidth = ihdr.width;
    const canvasHeight = ihdr.height;
    const canvas = new Uint8Array(canvasWidth * canvasHeight * 4);
    let previousCanvas: Uint8Array | null = null;

    const result: IDecodedFrame[] = new Array(rawFrames.length);

    for (let f = 0; f < rawFrames.length; f++) {
        const { fcTL, data } = rawFrames[f];

        // save canvas before drawing if dispose is PREVIOUS
        if (fcTL.disposeOp === DISPOSE_PREVIOUS) {
            previousCanvas = new Uint8Array(canvas);
        }

        // decode this frame's pixels
        const framePixels = decodePixels(data, fcTL.width, fcTL.height, ihdr, palette, transparency);

        // Full-canvas frames always use BLEND_SOURCE: the frame IS the entire image,
        // so transparent source pixels should clear the canvas rather than preserve old content.
        // Without this, DISPOSE_NONE + BLEND_OVER on a transparent-background APNG would show
        // ghosting (previous frame content visible through transparent areas).
        const isFullCanvas = fcTL.width === canvasWidth && fcTL.height === canvasHeight
            && fcTL.xOffset === 0 && fcTL.yOffset === 0;
        const blendOp = isFullCanvas ? BLEND_SOURCE : fcTL.blendOp;

        // render onto canvas
        for (let y = 0; y < fcTL.height; y++) {
            for (let x = 0; x < fcTL.width; x++) {
                const cx = fcTL.xOffset + x;
                const cy = fcTL.yOffset + y;
                if (cx >= canvasWidth || cy >= canvasHeight) continue;

                const srcIdx = (y * fcTL.width + x) * 4;
                const dstIdx = (cy * canvasWidth + cx) * 4;

                if (blendOp === BLEND_SOURCE) {
                    canvas[dstIdx] = framePixels[srcIdx];
                    canvas[dstIdx + 1] = framePixels[srcIdx + 1];
                    canvas[dstIdx + 2] = framePixels[srcIdx + 2];
                    canvas[dstIdx + 3] = framePixels[srcIdx + 3];
                } else {
                    // BLEND_OVER: alpha compositing
                    const srcA = framePixels[srcIdx + 3];
                    if (srcA === 255) {
                        canvas[dstIdx] = framePixels[srcIdx];
                        canvas[dstIdx + 1] = framePixels[srcIdx + 1];
                        canvas[dstIdx + 2] = framePixels[srcIdx + 2];
                        canvas[dstIdx + 3] = 255;
                    } else if (srcA > 0) {
                        const dstA = canvas[dstIdx + 3];
                        const outA = srcA + dstA * (255 - srcA) / 255;
                        if (outA > 0) {
                            canvas[dstIdx] = (framePixels[srcIdx] * srcA + canvas[dstIdx] * dstA * (255 - srcA) / 255) / outA;
                            canvas[dstIdx + 1] = (framePixels[srcIdx + 1] * srcA + canvas[dstIdx + 1] * dstA * (255 - srcA) / 255) / outA;
                            canvas[dstIdx + 2] = (framePixels[srcIdx + 2] * srcA + canvas[dstIdx + 2] * dstA * (255 - srcA) / 255) / outA;
                            canvas[dstIdx + 3] = outA;
                        }
                    }
                    // srcA === 0: do nothing (fully transparent source pixel)
                }
            }
        }

        // calculate frame duration in ms
        const delayDen = fcTL.delayDen || 100;
        const duration = (fcTL.delayNum * 1000) / delayDen;

        result[f] = {
            data: new Uint8Array(canvas),
            duration: duration || 100,
        };

        // apply disposal
        switch (fcTL.disposeOp) {
        case DISPOSE_BACKGROUND:
            for (let y = 0; y < fcTL.height; y++) {
                for (let x = 0; x < fcTL.width; x++) {
                    const cx = fcTL.xOffset + x;
                    const cy = fcTL.yOffset + y;
                    if (cx >= canvasWidth || cy >= canvasHeight) continue;
                    const dstIdx = (cy * canvasWidth + cx) * 4;
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
        }
    }

    return result;
}

// ----- binary helpers -----

function readU32 (data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readU16 (data: Uint8Array, offset: number): number {
    return (data[offset] << 8) | data[offset + 1];
}

function readChunkType (data: Uint8Array, offset: number): string {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function concatBytes (chunks: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (let i = 0; i < chunks.length; i++) {
        totalLen += chunks[i].length;
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        result.set(chunks[i], offset);
        offset += chunks[i].length;
    }
    return result;
}
