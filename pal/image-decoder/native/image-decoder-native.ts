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
import { sniffMime } from '../mime-sniff';
import { createGifDecoder } from '../gif/gif-decoder';
import { createApngDecoder } from '../apng/apng-decoder';

export function isNativeAnimatedSupported (mime: string): boolean {
    return false;
}

export function createAnimatedDecoder (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder> {
    const actual = sniffMime(bytes, mime);
    if (actual === 'image/gif') return Promise.resolve(createGifDecoder(bytes));
    if (actual === 'image/apng') return Promise.resolve(createApngDecoder(bytes));
    if (actual === 'image/png' || actual === 'image/jpeg') return createStaticDecoder(bytes, actual);
    return Promise.reject(new Error(`Unsupported animated image format: ${actual}`));
}

function createStaticDecoder (bytes: Uint8Array, mime: string): Promise<IAnimatedImageDecoder> {
    return new Promise<IAnimatedImageDecoder>((resolve, reject) => {
        const img = new (globalThis as any).Image() as HTMLImageElement;
        img.onload = (): void => {
            try {
                if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(img.src);
                }
                const w = img.width;
                const h = img.height;
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(img, 0, 0);
                const imageData = ctx.getImageData(0, 0, w, h);
                const data = new Uint8Array(imageData.data.buffer.slice(0));
                const frame: IDecodedFrame = { data, duration: 0 };
                resolve({
                    width: w,
                    height: h,
                    frameCount: 1,
                    loopCount: 0,
                    decodeFrame (): Promise<IDecodedFrame> { return Promise.resolve(frame); },
                    destroy (): void { /* nothing to release */ },
                } as IAnimatedImageDecoder);
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = (): void => {
            reject(new Error(`Failed to decode static ${mime} image`));
        };
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            img.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
        } else {
            img.src = `data:${mime};base64,${arrayBufferToBase64(bytes)}`;
        }
    });
}

function arrayBufferToBase64 (bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
