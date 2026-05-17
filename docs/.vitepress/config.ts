import { defineConfig } from 'vitepress';

const githubUrl = 'https://github.com/burakarslan0110/codewikitap-mcp';
const npmUrl = 'https://www.npmjs.com/package/codewikitap';

export default defineConfig({
  title: 'CodeWikiTap',
  description:
    'Unofficial, RAG-powered MCP server that streams Google CodeWiki documentation into coding agents.',
  base: '/codewikitap-mcp/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: 'localhostLinks',
  srcExclude: ['plans/**', '**/README.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/codewikitap-mcp/logo-icon.png' }],
    ['meta', { name: 'og:image', content: '/codewikitap-mcp/banner.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  themeConfig: {
    logo: '/logo-icon.png',
    siteTitle: 'CodeWikiTap',
    socialLinks: [
      { icon: 'github', link: githubUrl },
      { icon: 'npm', link: npmUrl },
    ],
    search: { provider: 'local' },
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      title: 'CodeWikiTap',
      description:
        'Unofficial, RAG-powered MCP server that streams Google CodeWiki documentation into coding agents.',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/concepts' },
          { text: 'Install', link: '/guide/installation' },
          { text: 'Tools', link: '/guide/tools' },
          { text: 'GitHub', link: githubUrl },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'Introduction',
              items: [
                { text: 'What is CodeWikiTap?', link: '/guide/concepts' },
                { text: 'Installation', link: '/guide/installation' },
              ],
            },
            {
              text: 'Deep dive',
              items: [
                { text: 'Architecture', link: '/guide/architecture' },
                { text: 'The 5 tools', link: '/guide/tools' },
                { text: 'Configuration', link: '/guide/configuration' },
              ],
            },
          ],
        },
        editLink: {
          pattern:
            'https://github.com/burakarslan0110/codewikitap-mcp/edit/main/docs/:path',
          text: 'Edit this page on GitHub',
        },
        docFooter: { prev: 'Previous', next: 'Next' },
        outline: { label: 'On this page' },
        lastUpdatedText: 'Last updated',
        darkModeSwitchLabel: 'Theme',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Back to top',
      },
    },
    tr: {
      label: 'Türkçe',
      lang: 'tr',
      link: '/tr/',
      title: 'CodeWikiTap',
      description:
        'Google CodeWiki dokümantasyonunu kodlama agent\'ına RAG ile akıtan unofficial MCP server.',
      themeConfig: {
        nav: [
          { text: 'Kılavuz', link: '/tr/guide/concepts' },
          { text: 'Kurulum', link: '/tr/guide/installation' },
          { text: 'Araçlar', link: '/tr/guide/tools' },
          { text: 'GitHub', link: githubUrl },
        ],
        sidebar: {
          '/tr/guide/': [
            {
              text: 'Giriş',
              items: [
                { text: 'CodeWikiTap nedir?', link: '/tr/guide/concepts' },
                { text: 'Kurulum', link: '/tr/guide/installation' },
              ],
            },
            {
              text: 'Derinlemesine',
              items: [
                { text: 'Mimari', link: '/tr/guide/architecture' },
                { text: '5 araç', link: '/tr/guide/tools' },
                { text: 'Yapılandırma', link: '/tr/guide/configuration' },
              ],
            },
          ],
        },
        editLink: {
          pattern:
            'https://github.com/burakarslan0110/codewikitap-mcp/edit/main/docs/:path',
          text: 'Bu sayfayı GitHub\'da düzenle',
        },
        docFooter: { prev: 'Önceki', next: 'Sonraki' },
        outline: { label: 'Bu sayfada' },
        lastUpdatedText: 'Son güncelleme',
        darkModeSwitchLabel: 'Tema',
        sidebarMenuLabel: 'Menü',
        returnToTopLabel: 'Yukarı çık',
      },
    },
  },
});
