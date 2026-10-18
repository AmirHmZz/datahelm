# DataHelm logos

These assets come from the original generated **03 — Cluster Helm** board in `source/option-3-board.png`. The approved artwork has the lowercase **datahelm** wordmark and green terminal dot. The login screen, dashboard sidebar, and repository README use the transparent dark and light SVG logos.

| File                                      | Purpose                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `datahelm-dark.png`, `datahelm-light.png` | Original dark/light artwork, losslessly cropped from the generated board.               |
| `datahelm-dark.svg`, `datahelm-light.svg` | Matching vector versions, including the original letterforms and dot as outlined paths. |
| `datahelm-monochrome.svg`                 | Complete monochrome vector logo.                                                        |
| `logo-mark.png`, `logo-mark.svg`          | Original standalone helm emblem, in PNG and vector form.                                |
| `favicon.png`, `favicon.svg`              | Original app icon from the board, in PNG and vector form.                               |
| `source/option-3-board.png`               | Original generated design board, preserved unchanged.                                   |
| `archive/`                                | Earlier reconstructed and screenshot-based assets, retained for reference.              |

SVGs contain vector paths without embedded raster images or font dependencies. Their contours are traced from the approved original; the flat vector fills use the project's mint, green, charcoal, and off-white palette. PNGs retain the original artwork's colors and texture.

To recreate these assets from the preserved original board:

```powershell
uv run scripts/prepare-logo-assets.py
```

The script declares its Pillow, NumPy, and VTracer dependencies inline. Raster crops are lossless; the SVG exporter fits smooth curves to the original artwork's contours.
