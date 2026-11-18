'use strict';

const sharp = require('sharp');
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const AVATAR_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function imageType(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
        bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
    return null;
}

async function sanitizeImage(bytes) {
    const type = imageType(bytes);
    if (!type || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid image.');
    const image = sharp(bytes, { animated: true, limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== (type === 'jpg' ? 'jpeg' : type) ||
        metadata.width * (metadata.pageHeight || metadata.height) * (metadata.pages || 1) > MAX_IMAGE_PIXELS) {
        throw new Error('Invalid image dimensions or format.');
    }
    const clean = await image.toFormat(metadata.format).toBuffer();
    if (clean.length > MAX_IMAGE_BYTES) throw new Error('Processed image exceeds 10 MB.');
    return { bytes: clean, type };
}

async function fetchAvatar(url, fetchImage = fetch) {
    if (typeof url !== 'string') throw new Error('Provide an HTTPS Discord CDN image URL.');
    const target = URL.parse(url);
    if (!target || target.protocol !== 'https:' || !AVATAR_HOSTS.has(target.hostname) ||
        target.port || target.username || target.password || target.hash ||
        !/^\/(?:attachments|avatars|embed\/avatars)\//.test(target.pathname)) {
        throw new Error('Provide an HTTPS Discord CDN image URL.');
    }

    const response = await fetchImage(target, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body) throw new Error('Could not download avatar image.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Avatar image exceeds 10 MB.');
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_IMAGE_BYTES) throw new Error('Avatar image exceeds 10 MB.');
            chunks.push(value);
        }
        return (await sanitizeImage(Buffer.concat(chunks, size))).bytes;
    } finally {
        try { await reader.cancel(); } catch { /* The response may already be aborted. */ }
        reader.releaseLock();
    }
}

module.exports = { fetchAvatar, sanitizeImage, MAX_IMAGE_BYTES };
