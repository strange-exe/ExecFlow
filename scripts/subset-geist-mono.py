"""Makes the Latin subsets of Geist Mono that ExecFlow ships (src/styles/fonts/).

Why not @fontsource-variable/geist-mono: its files have no coding ligatures, so "Joined symbols
in code" changed nothing (0.36.0). Geist Mono keeps them in Stylistic Set 11 ("Coding ligatures",
https://github.com/vercel/geist-font/releases, 1.7.0). The `geist` npm package can't be a
dependency here: it needs `next` as a peer, which npm would install.

Run by hand when updating the font, with fontTools and brotli installed:
  1. npm pack geist@<version> into an empty folder and extract it (check dist.integrity first).
  2. python -I scripts/subset-geist-mono.py <extracted>/package/dist/fonts/geist-mono src/styles/fonts <version>
  3. Copy <extracted>/package/LICENSE.txt to licenses/geist-mono-<version>-OFL.txt and update the
     version in tokens.css, about-tokens.css, vite.config.ts and the README.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

# The same range as Fontsource's "latin" subset, which the site used before.
LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
    "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
)

FILES = {"GeistMono-Variable.woff2": "normal", "GeistMono-Italic[wght].woff2": "italic"}


def features(path: Path) -> set[str]:
    font = TTFont(path)
    return {r.FeatureTag for r in font["GSUB"].table.FeatureList.FeatureRecord}


def main(src: str, out: str, version: str) -> None:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, style in FILES.items():
        source = Path(src) / name
        target = out_dir / f"geist-mono-{version}-latin-wght-{style}.woff2"
        options = subset.Options()
        options.layout_features = ["*"]  # keep ss11 and every other feature
        options.flavor = "woff2"
        options.name_IDs = ["*"]  # ss11's "Coding ligatures" label lives in the name table
        options.notdef_outline = True
        font = subset.load_font(str(source), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=subset.parse_unicodes(LATIN))
        subsetter.subset(font)
        subset.save_font(font, str(target), options)
        if "ss11" not in features(target):
            raise SystemExit(f"{target}: ss11 (coding ligatures) was lost")
        print(f"{target}  {target.stat().st_size} bytes")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: subset-geist-mono.py <geist-mono font dir> <out dir> <version>")
    main(*sys.argv[1:])
