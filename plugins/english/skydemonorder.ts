import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

class SkyDemonOrder implements Plugin.PluginBase {
  id = 'skydemonorder';
  name = 'Sky Demon Order';
  icon = 'src/en/skydemonorder/icon.png';
  site = 'https://skydemonorder.com';
  version = '1.0.0';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://skydemonorder.com/',
    },
  };

  filters = {
    status: {
      type: FilterTypes.Picker,
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
      ],
    },
  } satisfies Filters;

  private projectBase = '/projects/';

  private extractNovelPath(url: string): string | undefined {
    if (!url.includes('/projects/')) return undefined;
    try {
      const urlObj = new URL(url, this.site);
      const match = urlObj.pathname.match(/^\/projects\/([^/]+)$/);
      return match ? match[1] : undefined;
    } catch {
      return undefined;
    }
  }

  private slugToName(slug: string): string {
    return slug
      .replace(/^\d+-/, '')
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  private cleanName(raw: string, path: string): string {
    let name = raw
      .replace(/\d+ ch·[^]*$/i, '')
      .replace(/\d+\s*(yr|mo|d|h)\s*ago.*$/i, '')
      .replace(/\d+\.\d+\s*$/g, '')
      .replace(/Ongoing.*/i, '')
      .replace(/Complete.*/i, '')
      .replace(/18\+\s*$/g, '')
      .trim();
    if (name.length < 3 || /^\d+$/.test(name) || name === '18+') {
      name = this.slugToName(path);
    }
    return name;
  }

  private async scrapeNovelList(urls: string[]): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    for (const pageUrl of urls) {
      const body = await fetchApi(pageUrl, {
        headers: {
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        },
      }).then(res => res.text());
      const $ = parseHTML(body);

      $('a[href*="/projects/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const path = this.extractNovelPath(href);
        if (!path || seen.has(path)) return;
        seen.add(path);

        const img = $(el).find('img').first();
        const imgAlt = img.attr('alt') || '';
        const cover = img.attr('src') || img.attr('data-src') || defaultCover;

        const rawText = $(el).text().trim();
        let name = this.cleanName(imgAlt || rawText, path);

        novels.push({ name, path, cover });
      });
    }

    return novels;
  }

  async popularNovels(
    pageNo: number,
    options: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];
    return this.scrapeNovelList([this.site + '/', this.site + '/projects']);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = `${this.site}${this.projectBase}${novelPath}`;
    const body = await fetchApi(url, {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    }).then(res => res.text());
    const $ = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('title').text().split('—')[0].trim() || novelPath,
    };

    const ogImage = $('meta[property="og:image"]').attr('content');
    novel.cover = ogImage || defaultCover;

    const description = $('meta[property="og:description"]').attr('content');
    novel.summary = description || '';

    const statusText = $.text();
    novel.status = statusText.includes('Complete')
      ? NovelStatus.Completed
      : NovelStatus.Ongoing;

    const chapters: Plugin.ChapterItem[] = [];

    const startLink = $('a:contains("Start Reading")').attr('href');
    if (!startLink) {
      novel.chapters = chapters;
      return novel;
    }

    let chapterUrl: string | undefined = startLink;
    let chapterNum = 0;
    const maxChapters = 2000;

    while (chapterUrl && chapterNum < maxChapters) {
      try {
        const chapterBody = await fetchApi(chapterUrl, {
          headers: { 'Accept-Encoding': 'gzip, deflate' },
        }).then(res => res.text());
        const c$ = parseHTML(chapterBody);
        chapterNum++;

        const fullTitle = c$('title').text();
        const chapterTitle =
          fullTitle.split(' — ')[0].trim() || `Chapter ${chapterNum}`;

        const chapterPath = chapterUrl.replace(this.site, '');

        chapters.push({
          name: chapterTitle,
          path: chapterPath,
          chapterNumber: chapterNum,
        });

        let nextUrl: string | undefined;

        c$('a').each((_, el) => {
          const elText = c$(el).text().trim().toUpperCase();
          const href = c$(el).attr('href') || '';
          if (elText === 'NEXT' && href.includes('/projects/')) {
            nextUrl = href;
          }
        });

        if (!nextUrl) {
          const navEl = c$('[data-keydown\\.right\\.document]');
          if (navEl.length) {
            const attr = navEl.first().attr('@keydown.right.document') || '';
            const match = attr.match(/window\.location\.href\s*=\s*'([^']+)'/);
            if (match) nextUrl = match[1];
          }
        }

        if (!nextUrl) {
          c$('a[href*="/projects/"]').each((_, el) => {
            const href = c$(el).attr('href') || '';
            const parent = c$(el).parent().text().trim().toUpperCase();
            if (parent.includes('NEXT') && href !== chapterUrl) {
              nextUrl = href;
            }
          });
        }

        chapterUrl = nextUrl;
      } catch {
        break;
      }
    }

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = chapterPath.startsWith('http')
      ? chapterPath
      : `${this.site}${chapterPath}`;
    const body = await fetchApi(url, {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    }).then(res => res.text());
    const $ = parseHTML(body);

    const chapterBody = $('#chapter-body');
    if (!chapterBody.length) return '';

    const footnotes: Record<string, string> = {};
    chapterBody.find('div.footnotes li.footnote').each((_, el) => {
      const fnId = $(el).attr('id') || '';
      const fnText = $(el).text().replace(/↩️?$/, '').trim();
      if (fnId) footnotes[fnId] = fnText;
    });
    chapterBody.find('div.footnotes').remove();

    chapterBody.find('sup').each((_, el) => {
      const links = $(el).find('a.footnote-ref');
      if (links.length) {
        const refs: string[] = [];
        links.each((__, a) => {
          const href = $(a).attr('href') || '';
          const fnId = href.replace('#', '');
          if (footnotes[fnId]) refs.push(footnotes[fnId]);
        });
        if (refs.length) {
          $(el).replaceWith(` <em>[${refs.join('; ')}]</em> `);
        } else {
          $(el).remove();
        }
      }
    });

    chapterBody.find('hr').replaceWith('<br/><p>***</p><br/>');

    chapterBody.find('a').each((_, el) => {
      $(el).replaceWith($(el).text());
    });

    let html = '';
    chapterBody.children().each((_, el) => {
      const tag = (el as any).tagName;
      if (tag === 'p') {
        const content = $(el).html() || '';
        html += `<p>${content}</p>`;
      } else if (
        tag === 'em' ||
        tag === 'strong' ||
        tag === 'b' ||
        tag === 'i'
      ) {
        html += `<p>${$.html($(el))}</p>`;
      }
    });

    return html || chapterBody.html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];

    const all = await this.scrapeNovelList([
      this.site + '/',
      this.site + '/projects',
    ]);

    const term = searchTerm.toLowerCase();
    const words = term.split(/\s+/).filter(w => w.length > 0);

    return all.filter(novel => {
      const nameLower = novel.name.toLowerCase();
      if (nameLower.includes(term)) return true;
      return words.every(w => nameLower.includes(w));
    });
  }

  resolveUrl = (path: string, isNovel?: boolean) => {
    if (path.startsWith('http')) return path;
    return this.site + path;
  };
}

export default new SkyDemonOrder();
