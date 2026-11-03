import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'obbyx',
  description: 'x402 payments on the Obyte network',
  cleanUrls: true,
  srcExclude: ['**/README.md'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Specs', link: '/specs/scheme_exact_obyte' },
      { text: 'ADR', link: '/adr/0001-trust-model' },
    ],
    sidebar: {
      '/': [
        {
          text: 'Guide',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Quickstart (testnet)', link: '/guide/quickstart-testnet' },
            { text: 'Playground', link: '/guide/playground' },
            { text: 'Facilitator', link: '/guide/facilitator' },
            { text: 'Payment channels', link: '/guide/channels' },
            { text: 'SDK', link: '/guide/sdk' },
            { text: 'x402 compatibility', link: '/guide/x402-compatibility' },
            { text: 'Security and trust', link: '/guide/security' },
            { text: 'Operations', link: '/guide/operations' },
            { text: 'Logging', link: '/guide/logging' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Facilitator HTTP API', link: '/reference/facilitator-api' },
            { text: 'Error codes', link: '/reference/errors' },
            { text: 'SDK API (TypeDoc)', link: '/api/index.html', target: '_blank' },
          ],
        },
        {
          text: 'Scheme specs',
          items: [
            { text: 'exact on Obyte', link: '/specs/scheme_exact_obyte' },
            { text: 'batch-settlement on Obyte', link: '/specs/scheme_batch_settlement_obyte' },
          ],
        },
        {
          text: 'Architecture decisions',
          items: [
            { text: '0001 Trust model', link: '/adr/0001-trust-model' },
            {
              text: '0002 exact: unit profile & finality',
              link: '/adr/0002-exact-unit-profile-and-finality',
            },
            {
              text: '0003 batch-settlement & watcher',
              link: '/adr/0003-batch-settlement-binding-and-watcher',
            },
            { text: '0004 Network identifiers', link: '/adr/0004-network-identifiers' },
            { text: '0005 Storage: SQLite', link: '/adr/0005-storage-sqlite-single-instance' },
            { text: '0006 Obyte libraries', link: '/adr/0006-obyte-libraries' },
            { text: '0007 Upstream to x402', link: '/adr/0007-upstream-x402' },
          ],
        },
      ],
    },
  },
});
