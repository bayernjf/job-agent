import { describe, expect, it } from 'vitest';
import { decodeEntities, stripHtml, collapseWhitespace } from './html.js';

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&lt;div&gt;')).toBe('<div>');
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&#x27;')).toBe("'");
    expect(decodeEntities('&quot;hi&quot;')).toBe('"hi"');
  });
});

describe('stripHtml', () => {
  it('handles Greenhouse double-escaped HTML', () => {
    // 双重转义：&lt;div class=&quot;x&quot;&gt;
    const doubleEscaped = '&lt;div class=&quot;x&quot;&gt;&lt;p&gt;Hello &amp;amp; World&lt;/p&gt;&lt;/div&gt;';
    const out = stripHtml(doubleEscaped);
    expect(out).toContain('Hello');
    expect(out).toContain('& World');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('<div');
  });

  it('strips tags, drops script/style and folds whitespace', () => {
    const html = '<style>.x{color:red}</style><h1>Title</h1><p>Para<br/>line two</p><script>bad()</script>';
    const out = stripHtml(html)!;
    expect(out).toContain('Title');
    expect(out).toContain('Para');
    expect(out).toContain('line two');
    expect(out).not.toContain('bad()');
    expect(out).not.toContain('color:red');
  });

  it('returns null for empty/blank input', () => {
    expect(stripHtml('')).toBeNull();
    expect(stripHtml('   ')).toBeNull();
    expect(stripHtml(null)).toBeNull();
  });

  it('truncates to maxLen', () => {
    const out = stripHtml('<p>' + 'a'.repeat(9000) + '</p>', 100)!;
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace to single line', () => {
    expect(collapseWhitespace('  a\n\n  b\t c ')).toBe('a b c');
  });
});
