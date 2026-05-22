# Style Guide — Guia de Placeholders.docx

Extracted from the source DOCX using python-docx. All values are exact as stored in the file.

---

## 1. Page Setup

| Property | Value |
|---|---|
| Paper size | 21.59 × 27.94 cm (US Letter) |
| Orientation | Portrait |
| Margin — top | 2.54 cm (1 in) |
| Margin — bottom | 2.54 cm (1 in) |
| Margin — left | 2.54 cm (1 in) |
| Margin — right | 2.54 cm (1 in) |

---

## 2. Body / Default Text

| Property | Value |
|---|---|
| Style name | Normal |
| Font | Calibri |
| Size | 11 pt |
| Color | (inherited — black) |

---

## 3. Heading Styles

All headings inherit **Calibri** from Normal. Sizes and colors below are explicit overrides.

| Style | Size | Weight | Italic | Color | Space Before |
|---|---|---|---|---|---|
| Title | 26 pt | normal | — | `#17365D` (dark navy) | — |
| Subtitle | 12 pt | normal | italic | `#4F81BD` (blue) | — |
| Heading 1 | 14 pt | **bold** | — | `#365F91` (dark blue) | 24 pt |
| Heading 2 | 13 pt | **bold** | — | `#4F81BD` (blue) | 10 pt |
| Heading 3 | 11 pt* | **bold** | — | `#4F81BD` (blue) | 10 pt |
| Heading 4 | 11 pt* | **bold** | italic | `#4F81BD` (blue) | 10 pt |
| Heading 5 | 11 pt* | normal | — | `#243F60` (dark blue) | 10 pt |
| Heading 6 | 11 pt* | normal | italic | `#243F60` (dark blue) | 10 pt |
| Heading 7 | 11 pt* | normal | italic | `#404040` (dark gray) | 10 pt |
| Heading 8 | 10 pt | normal | — | `#4F81BD` (blue) | 10 pt |
| Heading 9 | 10 pt | normal | italic | `#404040` (dark gray) | 10 pt |

*inherits 11 pt from Normal

All headings have **0 pt space after**.

---

## 4. Other Named Paragraph Styles

| Style | Font | Size | Style | Color | Notes |
|---|---|---|---|---|---|
| Caption | Calibri | 9 pt | **bold** | `#4F81BD` | Used for figure/table captions |
| Quote | Calibri | 11 pt* | italic | `#000000` | |
| Intense Quote | Calibri | 11 pt* | **bold** italic | `#4F81BD` | Indent L+R 1.65 cm; 10 pt before, 14 pt after |
| macro | Courier | 10 pt | — | — | Monospace / code |
| Body Text | Calibri | 11 pt* | — | — | 6 pt after |
| Body Text 2 | Calibri | 11 pt* | — | — | 6 pt after, double line spacing |
| Body Text 3 | Calibri | 8 pt | — | — | 6 pt after |
| List Paragraph | Calibri | 11 pt* | — | — | Left indent 1.27 cm |

---

## 5. Character Styles

| Style | Size | Weight | Italic | Underline | Color |
|---|---|---|---|---|---|
| Strong | — | **bold** | — | — | — |
| Emphasis | — | — | italic | — | — |
| Subtle Emphasis | — | — | italic | — | `#808080` (gray) |
| Intense Emphasis | — | **bold** | italic | — | `#4F81BD` (blue) |
| Subtle Reference | — | — | — | single | `#C0504D` (red) |
| Intense Reference | — | **bold** | — | single | `#C0504D` (red) |

---

## 6. Theme Color Palette

These are the document's 12 named theme color slots (Office 2007 palette).

| Slot | Role | Hex |
|---|---|---|
| dk1 | Dark 1 (primary text) | `#000000` |
| lt1 | Light 1 (page background) | `#FFFFFF` |
| dk2 | Dark 2 | `#1F497D` |
| lt2 | Light 2 | `#EEECE1` |
| accent1 | Accent 1 — primary blue | `#4F81BD` |
| accent2 | Accent 2 — red | `#C0504D` |
| accent3 | Accent 3 — green | `#9BBB59` |
| accent4 | Accent 4 — purple | `#8064A2` |
| accent5 | Accent 5 — teal | `#4BACC6` |
| accent6 | Accent 6 — orange | `#F79646` |
| hlink | Hyperlink | `#0000FF` |
| folHlink | Followed hyperlink | `#800080` |

**Key colors in use:**
- `#17365D` — Title (deep navy)
- `#365F91` — Heading 1 (dark blue)
- `#4F81BD` — Heading 2/3/4/Subtitle/Caption (medium blue = accent1)
- `#243F60` — Heading 5/6 (navy)
- `#1F497D` — dk2 (dark blue)
- `#404040` — Heading 7/9 (dark gray)

---

## 7. Table Styles

### 7a. Table Grid (basic, all borders)

The simplest table style used as a foundation by many documents.

| Property | Value |
|---|---|
| Base | Normal Table |
| All borders | single line, 1 pt |
| Border color | (none specified — inherits black) |
| Cell margin left/right | 0.19 cm |
| Cell margin top/bottom | 0 cm |

### 7b. Light List Accent 1 (most common styled table)

Characteristic of the document's color scheme.

| Property | Value |
|---|---|
| Outer borders | single, 2 pt, `#4F81BD` |
| Inner borders | none |
| Header row (firstRow) | **bold**, white text `#FFFFFF`, fill `#4F81BD` |
| Last row | **bold** |
| First/Last column | **bold** |
| Cell margin left/right | 0.19 cm |

### 7c. Medium Shading 1 Accent 1

| Property | Value |
|---|---|
| Borders | single, 2 pt, `#7BA0CD` (top/bottom/left/right + insideH) |
| Header row (firstRow) | **bold**, white `#FFFFFF`, fill `#4F81BD` |
| Alternating rows (band1Horz) | fill `#D3DFEE` (light blue) |
| Alternating columns (band1Vert) | fill `#D3DFEE` |
| Cell margin left/right | 0.19 cm |

### 7d. Light Shading Accent 1

| Property | Value |
|---|---|
| Top/bottom borders only | single, 2 pt, `#4F81BD` |
| Header row | **bold** |
| Alternating rows/cols | fill `#D3DFEE` (light blue) |
| Cell margin left/right | 0.19 cm |

### Common pattern across all accent-colored table styles

- Primary accent color drives border and header fill
- Alternating band fill is always a ~80% tint of the accent color
- Header row: white text on solid accent fill, bold
- Cell padding: 0.19 cm left/right, 0 top/bottom (tight cells)
