import axios from 'axios';
import sharp from 'sharp';

// ───────────── настройки (через env) ─────────────
// Водяной знак OLX стоит в правом нижнем углу: срезаем нижние ~9% кадра.
const CROP_BOTTOM_RATIO = Number(process.env.OLX_WATERMARK_CROP || 0.09);
// PHOTO_ENHANCE=0 полностью отключает улучшение (у OLX остаётся только обрезка).
const ENHANCE = process.env.PHOTO_ENHANCE !== '0';
// PHOTO_ENHANCE_ALL=0 — улучшать только OLX (по умолчанию улучшаем все сайты).
const ENHANCE_ALL = process.env.PHOTO_ENHANCE_ALL !== '0';
const MIN_WIDTH = Number(process.env.PHOTO_MIN_WIDTH || 1280); // апскейл мелких фото до этой ширины
const MAX_WIDTH = Number(process.env.PHOTO_MAX_WIDTH || 1600); // большие фото уменьшаем (скорость, лимиты Telegram)
const MAX_UPSCALE = 2.5;
const JPEG_QUALITY = Number(process.env.PHOTO_JPEG_QUALITY || 92);

// Сила эффекта: 1 = «средний» режим (подобран по тестовому фото). 0.5 — мягче, 1.4 — сильнее.
const STRENGTH = Number(process.env.PHOTO_ENHANCE_STRENGTH || 1);

const OLX_HOST_RE = /(^|\.)olxcdn\.com$|(^|\.)olx\.uz$/i;

function isOlxImage(url) {
  try {
    return OLX_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Баланс белого: по ярким малонасыщенным пикселям (стены, потолок) → нейтральный белый. */
function whiteBalanceGains(raw) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < raw.length; i += 12) { // каждый 4-й пиксель
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if ((r + g + b) / 3 > 150 && mx - mn < 28) { sr += r; sg += g; sb += b; n++; }
  }
  if (n < 500) return [1, 1, 1]; // мало нейтральных пикселей — не рискуем
  const m = (sr + sg + sb) / 3 / n;
  const k = 0.7 * Math.min(1, STRENGTH); // 70% от расчётной коррекции
  return [m / (sr / n), m / (sg / n), m / (sb / n)].map((v) => clamp(1 + (v - 1) * k, 0.9, 1.1));
}

/**
 * Кривая тона (LUT 256): адаптивно растягивает контраст и подсвечивает тёмные кадры,
 * затем добавляет мягкую S-кривую.
 */
function buildToneLut(raw, wb) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < raw.length; i += 12) {
    const r = Math.min(255, raw[i] * wb[0]), g = Math.min(255, raw[i + 1] * wb[1]), b = Math.min(255, raw[i + 2] * wb[2]);
    hist[(r * 77 + g * 150 + b * 29) >> 8]++;
    n++;
  }
  const pct = (p) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * p) return i; }
    return 255;
  };
  const lo = Math.min(pct(0.005), 50);
  const hi = Math.max(pct(0.995), 150);
  const span = Math.max(hi - lo, 255 / 1.8);
  const stretch = span < 235;
  const base = (x) => (stretch ? clamp((x - lo) / span, 0, 1) : x / 255);

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += base(i) * hist[i];
  const meanNorm = sum / n;

  // тёмные кадры подсвечиваем до средней яркости ~0.46, остальным лёгкий подъём середины
  let g = 0.95;
  if (meanNorm < 0.42) g = clamp(Math.log(0.46) / Math.log(Math.max(meanNorm, 0.02)), 0.62, 0.95);
  g = 1 - (1 - g) * Math.min(STRENGTH, 1.5);

  const sMix = 0.28 * STRENGTH;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let x = Math.pow(base(i), g);
    const s = x * x * (3 - 2 * x);
    x = x * (1 - sMix) + s * sMix;
    lut[i] = Math.round(clamp(x, 0, 1) * 255);
  }
  return lut;
}

/** Полное улучшение: баланс белого → тон → насыщенность → локальный контраст → резкость. */
async function enhance(src, { upscaleTo, maxWidth }) {
  let pipe = sharp(src).rotate().removeAlpha();
  if (upscaleTo) pipe = pipe.resize({ width: upscaleTo, kernel: 'lanczos3' });
  else if (maxWidth) pipe = pipe.resize({ width: maxWidth, withoutEnlargement: true });

  const { data: raw, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const wb = whiteBalanceGains(raw);
  const lut = buildToneLut(raw, wb);
  const sat = 1 + 0.12 * STRENGTH;

  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const r = lut[Math.min(255, raw[i] * wb[0]) | 0];
    const g = lut[Math.min(255, raw[i + 1] * wb[1]) | 0];
    const b = lut[Math.min(255, raw[i + 2] * wb[2]) | 0];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out[i] = clamp(l + (r - l) * sat, 0, 255);
    out[i + 1] = clamp(l + (g - l) * sat, 0, 255);
    out[i + 2] = clamp(l + (b - l) * sat, 0, 255);
  }

  // Локальный контраст: out + a * (out - blur(out)), большой радиус → «объём» и фактура
  const blur = await sharp(out, { raw: { width, height, channels: 3 } }).blur(25).raw().toBuffer();
  const a = 0.22 * STRENGTH;
  for (let i = 0; i < out.length; i++) out[i] = clamp(out[i] + a * (out[i] - blur[i]), 0, 255);

  return sharp(out, { raw: { width, height, channels: 3 } })
    .sharpen({ sigma: upscaleTo ? 1.0 : 0.9, m1: 0.8, m2: 1.5 })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

/**
 * Скачивает фото, (для OLX) срезает водяной знак, улучшает.
 * При любой ошибке возвращает исходный URL, чтобы отправка в Telegram не ломалась.
 *
 * @param {string} url
 * @returns {Promise<Buffer|string>}
 */
export async function cleanPhoto(url) {
  const olx = isOlxImage(url);
  if (!olx && !(ENHANCE && ENHANCE_ALL)) return url;

  try {
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Chrome/120.0)' },
    });

    const { width, height } = await sharp(data).metadata();
    if (!width || !height) return url;

    // 1. Обрезка водяного знака (только OLX)
    let src = data;
    if (olx) {
      src = await sharp(data)
        .rotate()
        .extract({ left: 0, top: 0, width, height: Math.floor(height * (1 - CROP_BOTTOM_RATIO)) })
        .toBuffer();
    }

    if (!ENHANCE) return await sharp(src).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();

    // 2. Улучшение
    const upscaleTo = width < MIN_WIDTH ? Math.min(MIN_WIDTH, Math.round(width * MAX_UPSCALE)) : 0;
    return await enhance(src, { upscaleTo, maxWidth: MAX_WIDTH });
  } catch (err) {
    console.warn(`[cleanPhoto] не удалось обработать ${url}: ${err.message}`);
    return url;
  }
}

export async function cleanPhotos(urls) {
  return Promise.all(urls.map(cleanPhoto));
}
