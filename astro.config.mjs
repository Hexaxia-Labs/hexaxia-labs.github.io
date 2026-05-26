// @ts-check

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read blog frontmatter at config-load time so the sitemap emits
// accurate <lastmod> tags per post. @astrojs/sitemap does not derive
// this automatically. Bing/Yandex/DDG (via Bing) reward correct
// lastmod with faster re-crawl; Google ignores changefreq but uses
// lastmod as a freshness signal for crawl prioritization.
function loadBlogDates() {
  const blogDir = join(__dirname, 'src', 'content', 'blog');
  const map = new Map();
  let mostRecent = null;
  for (const file of readdirSync(blogDir)) {
    if (!file.endsWith('.md') && !file.endsWith('.mdx')) continue;
    const slug = file.replace(/\.mdx?$/, '');
    const raw = readFileSync(join(blogDir, file), 'utf-8');
    const pub = raw.match(/^pubDate:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1]?.trim();
    const upd = raw.match(/^updatedDate:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1]?.trim();
    const dateStr = upd || pub;
    if (dateStr) {
      const iso = new Date(dateStr).toISOString();
      map.set(slug, iso);
      if (!mostRecent || iso > mostRecent) mostRecent = iso;
    }
  }
  return { map, mostRecent };
}

const { map: blogDates, mostRecent: mostRecentBlog } = loadBlogDates();

// https://astro.build/config
export default defineConfig({
  site: 'https://labs.hexaxia.tech',
  integrations: [
    mdx(),
    sitemap({
      serialize(item) {
        const url = new URL(item.url);
        const path = url.pathname;
        // Per-post lastmod from frontmatter (updatedDate wins over pubDate)
        const blogMatch = path.match(/^\/blog\/([^/]+)\/?$/);
        if (blogMatch && blogDates.has(blogMatch[1])) {
          item.lastmod = blogDates.get(blogMatch[1]);
          item.changefreq = 'monthly';
        } else if (path === '/' && mostRecentBlog) {
          // Index mirrors the most recent blog post since it lists them
          item.lastmod = mostRecentBlog;
          item.changefreq = 'weekly';
        } else if (path === '/about/') {
          item.changefreq = 'monthly';
        }
        return item;
      },
    }),
  ],

  // The blog index lives at the site root; keep the old /blog path working.
  redirects: {
    '/blog': '/',
  },

  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-inter',
      weights: [300, 400, 600],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext', 'greek'],
      fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      display: 'swap',
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});