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

import { ccclass, menu, executeInEditMode, requireComponent, tooltip, type, serializable, range, slide, visible } from 'cc.decorator';
import { Component } from '../../core/components/component';
import { Sprite } from './sprite';
import { BufferAsset } from '../../core/assets/buffer-asset';
import { ImageAsset } from '../../core/assets/image-asset';
import { ccenum, warn } from '../../core';
import { AnimatedImagePlayer } from '../animated-image/animated-image-player';
import { SpriteFrame } from '../assets/sprite-frame';
import { sniffMime } from '../../../pal/image-decoder/mime-sniff';

/**
 * @en The source type of an [[AnimatedImage]].
 * @zh [[AnimatedImage]] 的来源类型。
 */
export enum AnimatedImageSourceType {
    /** @en A local `BufferAsset` holding the encoded bytes. @zh 持有编码字节的本地 `BufferAsset`。 */
    LOCAL = 0,
    /** @en A remote URL fetched at runtime. @zh 运行时拉取的远程 URL。 */
    REMOTE = 1,
    /**
     * @en An `ImageAsset` imported the default way. Recommended:
     * import the image as a normal image and drag it onto the component.
     * @zh 按默认方式导入的图片资源 `ImageAsset`。推荐用法：把图片当普通图片
     * 导入后直接拖到组件上。
     */
    IMAGE = 2,
}
ccenum(AnimatedImageSourceType);

/**
 * @en
 * A component that plays an animated image (APNG / GIF) on the [[Sprite]] of the same node. It wraps the
 * low-level [[AnimatedImagePlayer]]: it loads the encoded bytes (from a local [[BufferAsset]] or a remote
 * URL), drives frame advancement every update, and feeds the refreshed sprite frame to the sibling `Sprite`.
 * @zh
 * 在同节点的 [[Sprite]] 上播放动画图片（APNG / GIF）的组件。它封装了底层的 [[AnimatedImagePlayer]]：
 * 加载编码字节（来自本地 [[BufferAsset]] 或远程 URL），每帧推进播放，并把刷新后的精灵帧交给同节点的 `Sprite`。
 */
@ccclass('cc.AnimatedImage')
@menu('2D/AnimatedImage')
@requireComponent(Sprite)
@executeInEditMode
export class AnimatedImage extends Component {
    @serializable
    protected _sourceType = AnimatedImageSourceType.IMAGE;
    @type(BufferAsset)
    @serializable
    protected _clip: BufferAsset | null = null;
    @type(ImageAsset)
    @serializable
    protected _image: ImageAsset | null = null;
    @serializable
    protected _remoteURL = '';
    @serializable
    protected _playOnAwake = true;
    @serializable
    protected _loop = true;
    @serializable
    protected _playbackRate = 1;

    protected _player: AnimatedImagePlayer | null = null;
    protected _sprite: Sprite | null = null;
    protected _staticSpriteFrame: SpriteFrame | null = null;
    /** guards against a stale async load overwriting a newer source */
    protected _loadToken = 0;

    /**
     * @en The source type: LOCAL (a `BufferAsset`) or REMOTE (a URL).
     * @zh 来源类型：LOCAL（`BufferAsset`）或 REMOTE（URL）。
     */
    @type(AnimatedImageSourceType)
    @tooltip('i18n:animated_image.sourceType')
    get sourceType (): AnimatedImageSourceType {
        return this._sourceType;
    }
    set sourceType (val) {
        if (this._sourceType !== val) {
            this._sourceType = val;
            this._reload();
        }
    }

    /**
     * @en The local buffer asset holding the encoded animated image bytes.
     * @zh 持有动画图片编码字节的本地缓冲资源。
     */
    @type(BufferAsset)
    @tooltip('i18n:animated_image.clip')
    @visible(function visibleLocalSource (this: AnimatedImage) { return this._sourceType === AnimatedImageSourceType.LOCAL; })
    get clip (): BufferAsset | null {
        return this._clip;
    }
    set clip (val) {
        if (this._clip !== val) {
            this._clip = val;
            this._reload();
        }
    }

    /**
     * @en The image asset to play. The original encoded bytes are
     * fetched via its `nativeUrl`. This is the recommended source: import an image and assign it here.
     * @zh 要播放的图片资源。会通过其 `nativeUrl` 获取原始编码字节。推荐用法：
     * 把图片导入后赋值到这里。
     */
    @type(ImageAsset)
    @tooltip('i18n:animated_image.image')
    @visible(function visibleImageSource (this: AnimatedImage) { return this._sourceType === AnimatedImageSourceType.IMAGE; })
    get image (): ImageAsset | null {
        return this._image;
    }
    set image (val) {
        if (this._image !== val) {
            this._image = val;
            this._reload();
        }
    }

    /**
     * @en The remote URL of the animated image (used when `sourceType` is REMOTE).
     * @zh 动画图片的远程 URL（当 `sourceType` 为 REMOTE 时使用）。
     */
    @tooltip('i18n:animated_image.remoteURL')
    @visible(function visibleRemoteSource (this: AnimatedImage) { return this._sourceType === AnimatedImageSourceType.REMOTE; })
    get remoteURL (): string {
        return this._remoteURL;
    }
    set remoteURL (val: string) {
        if (this._remoteURL !== val) {
            this._remoteURL = val;
            this._reload();
        }
    }

    /**
     * @en Whether to start playing automatically after the image is loaded.
     * @zh 图片加载完成后是否自动开始播放。
     */
    @tooltip('i18n:animated_image.playOnAwake')
    get playOnAwake (): boolean {
        return this._playOnAwake;
    }
    set playOnAwake (value) {
        this._playOnAwake = value;
    }

    /**
     * @en Whether the animation loops.
     * @zh 动画是否循环播放。
     */
    @tooltip('i18n:animated_image.loop')
    get loop (): boolean {
        return this._loop;
    }
    set loop (value) {
        this._loop = value;
        if (this._player) {
            this._player.loop = value;
        }
    }

    /**
     * @en The playback rate. The value range is [0.0, 10.0].
     * @zh 播放速率，取值区间为 [0.0, 10.0]。
     */
    @slide
    @range([0.0, 10.0, 0.1])
    @tooltip('i18n:animated_image.playbackRate')
    get playbackRate (): number {
        return this._playbackRate;
    }
    set playbackRate (value: number) {
        this._playbackRate = value;
    }

    public static SourceType = AnimatedImageSourceType;

    /** @en Total frame count, or 0 before loaded. @zh 总帧数，加载前为 0。 */
    get frameCount (): number {
        return this._player ? this._player.frameCount : 0;
    }

    /** @en Index of the currently displayed frame. @zh 当前显示帧的索引。 */
    get currentFrame (): number {
        return this._player ? this._player.currentFrame : 0;
    }

    /** @en Total duration in milliseconds (see [[AnimatedImagePlayer.duration]]). @zh 总时长（毫秒）。 */
    get duration (): number {
        return this._player ? this._player.duration : 0;
    }

    /** @en Whether it is currently playing. @zh 当前是否正在播放。 */
    get isPlaying (): boolean {
        return !!this._player && this._player.state === 1; // PLAYING
    }

    /** @en The underlying player, or null before loaded. @zh 底层播放器，加载前为 null。 */
    get player (): AnimatedImagePlayer | null {
        return this._player;
    }

    public onLoad (): void {
        this._sprite = this.getComponent(Sprite);
        this._reload();
    }

    public onEnable (): void {
        if (this._player && this._playOnAwake) {
            this._player.play();
        }
    }

    public onDisable (): void {
        if (this._player) {
            this._player.pause();
        }
    }

    public onDestroy (): void {
        this._loadToken++;
        this._destroyPlayer();
        this._sprite = null;
    }

    public update (dt: number): void {
        if (this._player) {
            this._player.tick(dt * this._playbackRate);
        }
    }

    /**
     * @en Starts playing. Restarts from frame 0 if stopped, resumes if paused.
     * @zh 开始播放。若已停止则从第 0 帧重新开始，若已暂停则继续播放。
     */
    public play (): void {
        this._player?.play();
    }

    /** @en Resumes a paused animation. @zh 继续播放已暂停的动画。 */
    public resume (): void {
        this._player?.resume();
    }

    /** @en Pauses on the current frame. @zh 在当前帧暂停。 */
    public pause (): void {
        this._player?.pause();
    }

    /** @en Stops and resets to frame 0. @zh 停止并回到第 0 帧。 */
    public stop (): void {
        this._player?.stop();
    }

    /** @en Jumps to the given frame index. @zh 跳转到给定帧索引。 */
    public seekToFrame (index: number): void {
        this._player?.seekToFrame(index);
    }

    protected _reload (): void {
        if (!this.node) {
            return;
        }
        const token = ++this._loadToken;
        this._destroyPlayer();

        const onBytes = (bytes: Uint8Array | null): void => {
            // a newer reload happened, or the component was destroyed, while we were loading.
            if (token !== this._loadToken || !this.node || !bytes) {
                return;
            }

            const mime = sniffMime(bytes);

            // Static image: display directly without animation player
            if (mime === 'image/png' || mime === 'image/jpeg') {
                if (this._sourceType === AnimatedImageSourceType.IMAGE && this._image) {
                    this._displayStaticImageAsset(this._image);
                } else {
                    // LOCAL / REMOTE: go through the decoder layer which returns a 1-frame decoder
                    this._createPlayerFromBytes(bytes, mime, token);
                }
                return;
            }

            this._createPlayerFromBytes(bytes, mime, token);
        };

        if (this._sourceType === AnimatedImageSourceType.REMOTE) {
            if (!this._remoteURL) {
                return;
            }
            this._downloadFromUrl(this._remoteURL, onBytes);
        } else if (this._sourceType === AnimatedImageSourceType.IMAGE) {
            // An image imported the default way keeps its original file; nativeUrl points at it (same-origin
            // in preview, so no CORS). Fetch the raw bytes and decode them ourselves.
            const url = this._image ? this._image.nativeUrl : '';
            if (!url) {
                return;
            }
            this._downloadFromUrl(url, onBytes);
        } else {
            if (!this._clip || !this._clip.validate()) {
                return;
            }
            const buffer = this._clip.buffer();
            if (!buffer) {
                return;
            }
            onBytes(new Uint8Array(buffer));
        }
    }

    /** Downloads raw bytes from a URL and hands them to `onBytes` (used by REMOTE and IMAGE sources). */
    protected _downloadFromUrl (url: string, onBytes: (bytes: Uint8Array | null) => void): void {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = (): void => {
            if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0) {
                onBytes(new Uint8Array(xhr.response as ArrayBuffer));
            } else {
                warn(`AnimatedImage: HTTP ${xhr.status} for ${url}`);
            }
        };
        xhr.onerror = (): void => {
            warn(`AnimatedImage failed to download ${url}`);
        };
        xhr.send();
    }

    protected _createPlayerFromBytes (bytes: Uint8Array, mime: string, token: number): void {
        AnimatedImagePlayer.create(bytes, mime).then((player) => {
            if (token !== this._loadToken || !this.node) {
                player.destroy();
                return;
            }
            player.loop = this._loop;
            this._player = player;
            if (this._sprite) {
                this._sprite.spriteFrame = player.spriteFrame;
            }
            if (this._playOnAwake && this.enabledInHierarchy) {
                player.play();
            }
        }).catch((e) => {
            warn(`AnimatedImage failed to create player: ${String(e)}`);
        });
    }

    /** For IMAGE source type with static PNG/JPEG — uses the ImageAsset directly, no decode overhead. */
    protected _displayStaticImageAsset (image: ImageAsset): void {
        const sf = SpriteFrame.createWithImage(image);
        sf.packable = false;
        this._staticSpriteFrame = sf;
        if (this._sprite) {
            this._sprite.spriteFrame = sf;
        }
    }

    protected _destroyPlayer (): void {
        if (this._player) {
            this._player.destroy();
            this._player = null;
        }
        if (this._staticSpriteFrame) {
            this._staticSpriteFrame.destroy();
            this._staticSpriteFrame = null;
        }
        if (this._sprite) {
            this._sprite.spriteFrame = null;
        }
    }
}
