import React from 'react';
import { isHtmlDocument } from '../../core/template';

/**
 * The e-mail as the recipient's client will show it: a sandboxed frame (no scripts, no forms, no navigation), white background,
 * the same body font as a typical mail client. Used for the template designer, the per-contact preview and the signature.
 */
export function HtmlPreview({ html, title = 'E-mail preview', height = 420 }: { html: string; title?: string; height?: number }) {
  // a whole HTML document is shown as it is; a fragment is put in a plain page with the usual mail body font
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#fff}body{font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2430;padding:16px;word-wrap:break-word}p{margin:0 0 12px}img{max-width:100%;height:auto}a{color:#2563eb}</style></head><body>${html || '<p style="color:#8a94a6">Nothing to show yet.</p>'}</body></html>`;
  return <iframe title={title} sandbox="" srcDoc={isHtmlDocument(html) ? html : page} style={{ width: '100%', height, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />;
}
