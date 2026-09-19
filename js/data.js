export const categories = Object.freeze({
  editorial: 'ედიტორიალი', portraits: 'პორტრეტები', family: 'ოჯახი', weddings: 'ქორწილები',
});
export const categoryNamesRu = Object.freeze({
  editorial: 'Эдиториал и мода', portraits: 'Портреты', family: 'Семья', weddings: 'Свадьбы и пары',
});
export const initialPhotos = [
  { id: '00000000-0000-4000-8000-000000000001', image_path: 'images/hero-bg.webp', title: 'ედიტორიალური პორტრეტი', category: 'editorial', sort_order: 10 },
  { id: '00000000-0000-4000-8000-000000000002', image_path: 'images/portfolio-4.webp', title: 'მშვიდი მზერა', category: 'portraits', sort_order: 20 },
  { id: '00000000-0000-4000-8000-000000000003', image_path: 'images/portfolio-1.webp', title: 'ოჯახური მომენტები', category: 'family', sort_order: 30 },
  { id: '00000000-0000-4000-8000-000000000004', image_path: 'images/portfolio-2.webp', title: 'ერთად ყოფნა', category: 'family', sort_order: 40 },
  { id: '00000000-0000-4000-8000-000000000005', image_path: 'images/portfolio-3.webp', title: 'პატარა ბედნიერება', category: 'family', sort_order: 50 },
  { id: '00000000-0000-4000-8000-000000000006', image_path: 'images/portfolio-5.webp', title: 'ჩვენი ისტორია', category: 'family', sort_order: 60 },
].map((photo) => ({ ...photo, alt: photo.title, published: true, source: 'local' }));

export function filterPhotos(photos, category) {
  return photos.filter((photo) => photo.published && (category === 'all' || photo.category === category));
}

export function validatePhoto(values) {
  const title = String(values.title || '').trim();
  const alt = String(values.alt || '').trim();
  const sortOrder = Number(values.sort_order);
  if (!title || title.length > 160) throw new Error('Название: от 1 до 160 символов.');
  if (!alt || alt.length > 300) throw new Error('Описание изображения: от 1 до 300 символов.');
  if (!Object.hasOwn(categories, values.category)) throw new Error('Выберите категорию.');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw new Error('Порядок: целое число от 0 до 1000000.');
  return { title, alt, category: values.category, sort_order: sortOrder, published: values.published === true };
}

export function validateImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Поддерживаются JPG, PNG и WebP. HEIC нужно преобразовать в JPG.');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Размер каждого исходного фото — до 20 МБ.');
}