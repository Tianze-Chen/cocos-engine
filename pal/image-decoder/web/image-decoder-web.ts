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

import { DEBUG } from 'internal:constants';

import { warn } from '../../../cocos/core/platform/debug';
import type { IAnimatedImageDecoder, IDecodedFrame } from '../type';
import { sniffMime } from '../mime-sniff';
import { createGifDecoder } from '../gif/gif-decoder';
import { createApngDecoder } from '../apng/apng-decoder';

interface WebImageDecoderTrack {
    frameCount: number;
    repetitionCount: number;
}
interface WebImageDecoderResult {
    image: {
        displayWidth: number;
        displayHeight: number;
        duration: number | null;
        close (): void;
    };
    complete: boolean;
}
interface WebImageDecoder {
    tracks: { ready: Promise<void>; selectedTrack: WebImageDecoderTrack | null };
    decode (options: { frameIndex: number }): Promise<WebImageDecoderResult>;
    close (): void;
}
interface WebImageDecoderCtor {
    new (init: { data: BufferSource; type: string }): WebImageDecoder;
    isTypeSupported (type: string): Promise<boolean>;
}

function getImageDecoderCtor (): WebImageDecoderCtor | undefined {
    return (globalThis as { ImageDecoder?: WebImageDecoderCtor }).ImageDecoder;
}

class WebCodecsDecoder implements IAnimatedImageDecoder {
    public readonly width: number;
    public readonly height: number;
    public readonly frameCount: number;
    public readonly loopCount: number;

    private _decoder: WebImageDecoder | null;
    private _canvas: OffscreenCanvas | HTMLCanvasElement;
    private _ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

    constructor (decoder: WebImageDecoder, width: number, height: number, frameCount: number, loopCount: number) {
        this._decoder = decoder;
        this.width = width;
        this.height = height;
        this.frameCount = frameCount;
        this.loopCount = loopCount;
        if (typeof OffscreenCanvas !== 'undefined') {
            this._canvas = new OffscreenCanvas(width, height);
        } else {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            this._canvas = canvas;
        }
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    }

    public async decodeFrame (index: number): Promise<IDecodedFrame> {
        if (!this._decoder) {
            throw new Error('animated image decoder has been destroyed');
        }
        const result = await this._decoder.decode({ frameIndex: index });
        const videoFrame = result.image;
        try {
            this._ctx.clearRect(0, 0, this.width, this.height);
            this._ctx.drawImage(videoFrame as unknown as CanvasImageSource, 0, 0);
            const imageData = this._ctx.getImageData(0, 0, this.width, this.height);
            const data = new Uint8Array(imageData.data.buffer.slice(0));
            const duration = videoFrame.duration != null ? videoFrame.duration / 1000 : 0;
            return { data, duration };
        } finally {
            videoFrame.close();
        }
    }

    public destroy (): void {
        if (this._decoder) {
            this._decoder.close();
            this._decoder = null;
        }
    }
}

export function isNativeAnimatedSupported (mime: string): boolean {
    return typeof getImageDecoderCtor() !== 'undefined';
}

function shouldForceBuiltin (): boolean {
    return (globalThis as { __forceBuiltinDecoder?: boolean }).__forceBuiltinDecoder === true;
}

async function tryCreateNative (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder | null> {
    const Ctor = getImageDecoderCtor();
    if (!Ctor) {
        return null;
    }
    try {
        if (typeof Ctor.isTypeSupported === 'function' && !(await Ctor.isTypeSupported(mime))) {
            return null;
        }
        const decoder = new Ctor({ data: bytes, type: mime });
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || !track.frameCount) {
            decoder.close();
            return null;
        }
        const first = await decoder.decode({ frameIndex: 0 });
        const width = first.image.displayWidth;
        const height = first.image.displayHeight;
        first.image.close();
        const repetition = track.repetitionCount;
        const loopCount = (repetition === Infinity || repetition < 0) ? 0 : repetition;
        return new WebCodecsDecoder(decoder, width, height, track.frameCount, loopCount);
    } catch (e) {
        if (DEBUG) {
            warn(`WebCodecs ImageDecoder failed for ${mime}: ${String(e)}`);
        }
        return null;
    }
}

export async function createAnimatedDecoder (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder> {
    const actual = sniffMime(bytes, mime);
    if (shouldForceBuiltin()) {
        if (DEBUG) {
            warn('[animated-image] forceBuiltinDecoder is on: skipping native WebCodecs and using the built-in JS decoder.');
        }
        return createJsFallback(bytes, actual);
    }
    const native = await tryCreateNative(bytes, actual);
    if (native) {
        return native;
    }
    return createJsFallback(bytes, actual);
}

function createJsFallback (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder> {
    if (mime === 'image/gif') return Promise.resolve(createGifDecoder(bytes));
    if (mime === 'image/apng') return Promise.resolve(createApngDecoder(bytes));
    if (mime === 'image/png' || mime === 'image/jpeg') return createStaticDecoder(bytes, mime);
    return Promise.reject(new Error(`Unsupported animated image format: ${mime}`));
}

function createStaticDecoder (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder> {
    const blob = new Blob([bytes], { type: mime });
    return createImageBitmap(blob).then((bitmap) => {
        const w = bitmap.width;
        const h = bitmap.height;
        let canvas: OffscreenCanvas | HTMLCanvasElement;
        if (typeof OffscreenCanvas !== 'undefined') {
            canvas = new OffscreenCanvas(w, h);
        } else {
            canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = new Uint8Array(imageData.data.buffer.slice(0));
        const frame: IDecodedFrame = { data, duration: 0 };
        return {
            width: w,
            height: h,
            frameCount: 1,
            loopCount: 0,
            decodeFrame (): Promise<IDecodedFrame> { return Promise.resolve(frame); },
            destroy (): void { /* nothing to release */ },
        } as IAnimatedImageDecoder;
    });
}
