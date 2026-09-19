import { validateImage } from './data.js';

export async function prepareImage(file) {
  validateImage(file);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Не удалось прочитать фото. Сохраните его как JPG и повторите.'); }
  try {
    if (bitmap.width * bitmap.height > 80000000) throw new Error('Фото слишком большое: максимум 80 мегапикселей.');
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не поддерживает обработку изображений.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', .86));
    if (!blob || blob.type !== 'image/webp') throw new Error('Обновите браузер: требуется поддержка WebP.');
    if (blob.size > 8 * 1024 * 1024) throw new Error('После сжатия фото превышает 8 МБ. Уменьшите исходный файл.');
    return blob;
  } finally { bitmap.close(); }
}