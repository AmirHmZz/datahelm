"""Extract the approved option 3 artwork and trace its silhouettes to SVG paths."""

# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2.0", "pillow>=11.0", "vtracer==0.6.15"]
# ///

from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import vtracer
from PIL import Image

GRAPHICS = Path(__file__).resolve().parents[1] / "frontend/public/graphics/logos"
SOURCE = GRAPHICS / "source/option-3-board.png"
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NAMESPACE)


def outline(mask, color):
    """Fit smooth curves to a foreground mask, retaining holes in the artwork."""
    raster = Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).convert("RGB")
    encoded = BytesIO()
    raster.save(encoded, format="PNG")
    traced = vtracer.convert_raw_image_to_svg(
        encoded.getvalue(),
        img_format="png",
        colormode="binary",
        mode="spline",
        filter_speckle=4,
        corner_threshold=60,
        length_threshold=3.5,
        splice_threshold=45,
        path_precision=2,
    )
    root = ET.fromstring(traced)
    paths = []
    for path in root.iter(f"{{{SVG_NAMESPACE}}}path"):
        path.set("fill", color)
        path.set("fill-rule", "evenodd")
        paths.append(ET.tostring(path, encoding="unicode"))
    return paths


def masks(image, theme):
    rgb = np.asarray(image.convert("RGB")).astype(int)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    if theme == "dark":
        green = (g > 112) & (g - r > 24) & (g - b > 12)
        white = (rgb.min(axis=2) > 118) & (rgb.max(axis=2) - rgb.min(axis=2) < 48)
        return [(green, "#52d9a2"), (white, "#e6ebe8")]
    green = (g - r > 22) & (g - b > 10) & (r < 120) & (g < 180)
    return [(green, "#147d52")]


def svg(image, layers, title):
    width, height = image.size
    paths = []
    for mask, color in layers:
        paths.extend(outline(mask, color))
    return (
        f'<svg xmlns="{SVG_NAMESPACE}" viewBox="0 0 {width} {height}" '
        'role="img" aria-labelledby="title">\n'
        f'  <title id="title">{title}</title>\n'
        + "\n".join(paths)
        + "\n</svg>\n"
    )


def write_logo(board, name, box, theme):
    image = board.crop(box)
    image.save(GRAPHICS / f"{name}.png")
    layers = masks(image, theme)
    (GRAPHICS / f"{name}.svg").write_text(svg(image, layers, "datahelm."), encoding="utf-8")
    print(f"{name}: {image.width} x {image.height}; smooth vectors from the original board")
    return image, layers


def main():
    board = Image.open(SOURCE).convert("RGB")
    assert board.size == (1536, 1024), f"Unexpected source board size: {board.size}"
    GRAPHICS.mkdir(parents=True, exist_ok=True)
    dark, dark_layers = write_logo(board, "datahelm-dark", (151, 225, 1410, 537), "dark")
    write_logo(board, "datahelm-light", (106, 741, 790, 919), "light")
    mono = [(mask, "#101312") for mask, _ in dark_layers]
    (GRAPHICS / "datahelm-monochrome.svg").write_text(svg(dark, mono, "datahelm."), encoding="utf-8")
    mark = board.crop((153, 225, 437, 537))
    mark.save(GRAPHICS / "logo-mark.png")
    (GRAPHICS / "logo-mark.svg").write_text(
        svg(mark, [masks(mark, "dark")[0]], "DataHelm cluster helm"), encoding="utf-8"
    )
    icon = board.crop((1251, 741, 1432, 935))
    icon.save(GRAPHICS / "favicon.png")
    rgb = np.asarray(icon).astype(int)
    tile = (rgb[:, :, 1] - rgb[:, :, 0] > 20) & (rgb[:, :, 1] - rgb[:, :, 2] > 10)
    # Pale emblem pixels have little chroma; keep the board background out of the mask.
    interior = np.zeros(tile.shape, dtype=bool)
    interior[18:-18, 18:-18] = True
    white = (rgb.min(axis=2) > 120) & (rgb.max(axis=2) - rgb.min(axis=2) < 50) & interior
    background = tile | white
    (GRAPHICS / "favicon.svg").write_text(
        svg(icon, [(background, "#147d52"), (white, "#e6ebe8")], "DataHelm icon"),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
