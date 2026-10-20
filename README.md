# Free PDF & Image Converter

A simple Smallpdf-style website for converting documents and images. Every conversion runs
**in the browser**, so files are never uploaded and there is no server code to host or pay for.

## Tools

| Tool | What it does |
| --- | --- |
| PDF to JPG | Each PDF page becomes a JPG or PNG image (72 / 150 / 300 DPI) |
| JPG to PDF | JPG, PNG, HEIC, WEBP, GIF, BMP, AVIF or SVG images → one PDF (or one PDF per image) |
| Merge PDF | Combine PDFs; drag to reorder |
| Split PDF | Split by ranges (`1-3, 5, 8-`), every page, or extract pages into one file |
| Compress PDF | Lossless clean-up, or re-encode pages as images for big savings |
| Rotate PDF | Rotate all pages or specific ones |
| Word to PDF | `.docx` → PDF with headings, lists, tables and images |
| Excel to PDF | `.xlsx`, `.xlsm`, `.xls`, `.xlsb` and `.csv` → PDF, keeping number formats, fonts, colours, borders and merged cells |
| ODF to PDF | OpenDocument from LibreOffice / OpenOffice → PDF: text documents (`.odt`), spreadsheets (`.ods`), presentations (`.odp`) and drawings (`.odg`), plus their templates |
| PDF to Text | Extract the text into a `.txt` file |
| Convert Image | Convert to JPG / PNG / WEBP / BMP, with optional resizing (HEIC input supported) |
| Compress Image | Lower the quality and/or limit the dimensions to shrink images |

## Limitations

- **Word to PDF** renders pages as high-resolution images, so text in the PDF can't be selected.
  Complex Word layouts (columns, text boxes, headers and footers) come out simplified.
  Old `.doc` files aren't supported.
- **ODF to PDF** follows the document's own styles: fonts, colours, alignment, spacing, lists,
  tables, images, page size and margins, manual page breaks, cell formatting, and slide backgrounds,
  shapes and text boxes. Charts, embedded objects, comments, and headers/footers are left out, and
  footnotes are collected at the end of the document. Spreadsheets print only the used cell range,
  shrink wide sheets to the page width (switching to landscape when needed), and stop after 5,000 rows
  per sheet. As with Word, the PDF pages are images, so text can't be selected.
- **Excel to PDF** reads `.xlsx`/`.xlsm` directly, so cell values, number formats (dates,
  currency, percentages, red negatives), fonts, fills (including theme colours), borders, alignment,
  wrapped text, merged cells, column widths, row heights, hidden rows/columns/sheets, print areas and
  "rows to repeat at top" all carry over. Each sheet keeps its own paper size and margins, and wide
  sheets shrink to fit the page width (turning landscape when needed). Charts, images, comments and
  conditional formatting are left out, formulas show their last saved result, and sheets stop after
  5,000 rows. `.xls`, `.xlsb` and `.csv` keep their values and layout but not colours or borders.
- **Compress PDF** "Recommended" and "Strong" turn pages into images (great for scans, but text
  stops being selectable). "Light" keeps the text but usually saves less.
- Password-protected PDFs need the password removed first.
- Converting *to* Word, Excel or PowerPoint needs a server-side engine (for example LibreOffice)
  and isn't included.
