import { Fragment, type ReactNode } from 'react';

/* Small, safe Markdown subset for AI replies: headings, lists, bold, inline code,
 * links and bare URLs. No raw HTML is ever injected. */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)）」』]+)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']('));
      out.push(
        <a key={key} href={m[2]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else
      out.push(
        <a key={key} href={tok} target="_blank" rel="noreferrer">
          {tok.length > 48 ? `${tok.slice(0, 45)}…` : tok}
        </a>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    const k = blocks.length;
    blocks.push(
      <Tag key={k}>
        {list.items.map((it, j) => (
          <li key={j}>{inline(it, `${k}-${j}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = !!ol && !ul;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
      return;
    }
    flush();
    if (!line.trim()) return;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <p key={`h${idx}`} className="md-h">
          {inline(h[1], `h${idx}`)}
        </p>,
      );
      return;
    }
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push(<hr key={`r${idx}`} />);
      return;
    }
    blocks.push(<p key={`p${idx}`}>{inline(line, `p${idx}`)}</p>);
  });
  flush();
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
