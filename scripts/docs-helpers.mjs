// Small helpers over the `docx` library: headings, paragraphs with `inline code`, bullets, tables, notes, images.
import fs from 'node:fs';
import { Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, ImageRun, PageBreak } from 'docx';

export const BLUE = '4570B6', LIGHT = 'CAEBFB', INK = '231F20', PALE = 'EEF6FB', LINE = 'D5DBE6';
const MONO = 'Consolas', BODY = 'Calibri', HEAD = 'Jost';

function runs(text, base = {}) {
  const out = []; const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('`')) out.push(new TextRun({ text: p.slice(1, -1), font: MONO, size: (base.size ?? 21) - 1, shading: { type: ShadingType.CLEAR, fill: 'F1F4F9', color: 'auto' }, ...base.extra }));
    else if (p.startsWith('**')) out.push(new TextRun({ text: p.slice(2, -2), bold: true, font: BODY, size: base.size ?? 21, ...base.extra }));
    else out.push(new TextRun({ text: p, font: BODY, size: base.size ?? 21, ...base.extra }));
  }
  return out;
}

export const H1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 140 }, keepNext: true, children: [new TextRun({ text: t, font: HEAD, bold: true, size: 34, color: BLUE })] });
export const H2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 }, keepNext: true, children: [new TextRun({ text: t, font: HEAD, bold: true, size: 26, color: INK })] });
export const H3 = t => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 60 }, keepNext: true, children: [new TextRun({ text: t, font: HEAD, bold: true, size: 22, color: BLUE })] });
export const P = (t, opts = {}) => new Paragraph({ spacing: { after: 100, line: 276 }, alignment: opts.align, children: runs(t, opts) });
export const B = items => items.map(t => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 50, line: 264 }, children: runs(t) }));
export const N = items => items.map(t => new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { after: 50, line: 264 }, children: runs(t) }));
export const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

export const Code = text => text.split('\n').map((line, i, a) => new Paragraph({ spacing: { after: 0, line: 240 }, shading: { type: ShadingType.CLEAR, fill: 'F4F6FA', color: 'auto' }, border: i === 0 ? { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } } : i === a.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } } : undefined, indent: { left: 120 }, children: [new TextRun({ text: line || ' ', font: MONO, size: 18 })] }));

export const Note = (text, kind = 'info') => {
  const fill = { info: 'EAF5FC', warn: 'FDF1D8', good: 'E2F4EA', bad: 'FDE7E5' }[kind]; const bar = { info: BLUE, warn: 'E0A526', good: '1F7A4D', bad: 'B3261E' }[kind];
  return new Paragraph({ spacing: { before: 80, after: 120, line: 264 }, shading: { type: ShadingType.CLEAR, fill, color: 'auto' }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: bar, space: 8 } }, indent: { left: 160, right: 80 }, children: runs(text) });
};

const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const cellBorders = { top: border, bottom: border, left: border, right: border };
export function T(headers, rows, widths) {
  const total = 9638; const w = widths ?? headers.map(() => Math.floor(total / headers.length)); const sum = w.reduce((a, b) => a + b, 0); const ws = w.map(x => Math.round((x / sum) * total));
  const cell = (text, i, head) => new TableCell({ width: { size: ws[i], type: WidthType.DXA }, borders: cellBorders, margins: { top: 60, bottom: 60, left: 100, right: 100 }, shading: head ? { type: ShadingType.CLEAR, fill: BLUE, color: 'auto' } : undefined,
    children: String(text).split('\n').map(line => new Paragraph({ spacing: { after: 20, line: 250 }, children: head ? [new TextRun({ text: line, bold: true, color: 'FFFFFF', font: BODY, size: 19 })] : runs(line, { size: 19 }) })) });
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: ws, rows: [...(headers.some(x => x) ? [new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((x, i) => cell(x, i, true)) })] : []), ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false)) }))] });
}
export const gap = () => new Paragraph({ spacing: { after: 80 }, children: [] });

/** PNG → ImageRun scaled to `width` points-ish (docx transformation is in pixels at 96 dpi). */
export function Img(file, width = 600, caption = '') {
  const buf = fs.readFileSync(file); const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20); const height = Math.round(width * h / w);
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 40 }, keepNext: !!caption, children: [new ImageRun({ type: 'png', data: buf, transformation: { width, height }, altText: { title: caption || file, description: caption || file, name: file } })] })];
  if (caption) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: caption, italics: true, size: 18, color: '4A4546', font: BODY })] }));
  return out;
}
