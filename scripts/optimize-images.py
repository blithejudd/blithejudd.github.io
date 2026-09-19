"""Optional one-time regeneration of committed responsive previews. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
output = root / 'images' / 'optimized'
output.mkdir(exist_ok=True)
for source in (root / 'images').glob('*.webp'):
    with Image.open(source) as original:
        for width in (480, 960):
            image = ImageOps.exif_transpose(original).convert('RGB')
            image.thumbnail((width, 20000))
            image.save(output / f'{source.stem}-{width}.webp', 'WEBP', quality=83, method=6)
            print(f'{source.stem}-{width}.webp: {image.width}x{image.height}')