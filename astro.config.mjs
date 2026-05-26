// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://labs.hexaxia.tech',
  integrations: [mdx(), sitemap()],

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