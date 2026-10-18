"""Regenerate the original password mask glyph (requires fonttools and brotli).

Run manually with Python from the repository root. No downloaded font outlines
are used. A 300-unit disc fits the 600-unit advance of Geist Mono digits, rather
than Urbanist's 107-unit bullet at 1000 units/em. Both states stay at 13 CSS px.
"""
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

font = FontBuilder(1000, isTTF=True)
font.setupGlyphOrder([".notdef", "mask"])
font.setupCharacterMap({0x2022: "mask", 0x25CF: "mask"})
empty = TTGlyphPen(None).glyph()
pen = TTGlyphPen(None)
pen.moveTo((300, 200))
pen.qCurveTo((150, 200), (150, 350))
pen.qCurveTo((150, 500), (300, 500))
pen.qCurveTo((450, 500), (450, 350))
pen.qCurveTo((450, 200), (300, 200))
pen.closePath()
font.setupGlyf({".notdef": empty, "mask": pen.glyph()})
font.setupHorizontalMetrics({".notdef": (600, 0), "mask": (600, 150)})
font.setupHorizontalHeader(ascent=1000, descent=-300)
font.setupOS2(sTypoAscender=1000, sTypoDescender=-300, usWinAscent=1000,
              usWinDescent=300, sxHeight=520, sCapHeight=700, usWeightClass=500)
font.setupNameTable({"familyName": "Deck Secret Mask", "styleName": "Regular",
                     "uniqueFontIdentifier": "DeckSecretMask-1", "fullName": "Deck Secret Mask",
                     "psName": "DeckSecretMask", "version": "Version 1.0",
                     "copyright": "Copyright XwX Deck contributors. Apache-2.0."})
font.setupPost()
font.font["head"].created = font.font["head"].modified = 3864643200
font.font.recalcTimestamp = False
font.font.flavor = "woff2"
font.save(Path(__file__).resolve().parents[2] / "assets/fonts/deck-secret-mask.woff2")
