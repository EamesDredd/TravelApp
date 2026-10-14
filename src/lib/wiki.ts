export interface WikiHit {
  title: string;
  snippet: string;
  url: string;
}

export interface WikiSummary {
  title: string;
  extract: string;
  thumbnail?: string;
  url: string;
}

const API = 'https://zh.wikipedia.org/w/api.php';

function stripTags(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

export async function wikiSearch(query: string): Promise<WikiHit[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
    origin: '*',
    uselang: 'zh-tw',
    variant: 'zh-tw',
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`維基百科搜尋失敗（${res.status}）`);
  const data = await res.json();
  const hits = (data?.query?.search ?? []) as Array<{ title: string; snippet: string }>;
  return hits.map((h) => ({
    title: h.title,
    snippet: stripTags(h.snippet),
    url: `https://zh.wikipedia.org/zh-tw/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
  }));
}

export async function wikiSummary(title: string): Promise<WikiSummary | null> {
  const res = await fetch(
    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    { headers: { 'Accept-Language': 'zh-tw' } },
  );
  if (!res.ok) return null;
  const d = await res.json();
  if (!d?.extract) return null;
  return {
    title: d.title,
    extract: d.extract,
    thumbnail: d.thumbnail?.source,
    url: d.content_urls?.mobile?.page ?? d.content_urls?.desktop?.page ?? '',
  };
}
