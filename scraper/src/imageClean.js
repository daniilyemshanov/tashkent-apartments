import axios from 'axios';
import sharp from 'sharp';

// Водяной знак OLX стоит в правом нижнем углу, у самого края.
// Срезаем нижние ~9% кадра — знак уходит целиком, кадр почти не страдает.
const CROP_BOTTOM_RATIO = Number(process.env.OLX_WATERMARK_CROP || 0.09);

// Чистим только фото OLX (другие сайты свой знак не вшивают).
const OLX_HOST_RE = /(^|\.)olxcdn\.com$|(^|\.)olx\.uz$/i;

function isOlxImage(url) {
  try {
    return OLX_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Для фото OLX: скачивает, срезает низ с водяным знаком, возвращает Buffer.
 * Для остальных, а также при любой ошибке — возвращает исходный URL,
 * чтобы отправка в Telegram не ломалась из-за обработки фото.
 *
 * @param {string} url
 * @returns {Promise<Buffer|string>}
 */
export async function cleanPhoto(url) {
  if (!isOlxImage(url)) return url;
  try {
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Chrome/120.0)' },
    });
    const img = sharp(data);
    const { width, height } = await img.metadata();
    if (!width || !height) return url;
    return await img
      .extract({ left: 0, top: 0, width, height: Math.floor(height * (1 - CROP_BOTTOM_RATIO)) })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.warn(`[cleanPhoto] не удалось обработать ${url}: ${err.message}`);
    return url;
  }
}

export async function cleanPhotos(urls) {
  return Promise.all(urls.map(cleanPhoto));
}
