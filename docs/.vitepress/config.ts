import { defineConfig } from "vitepress";

export default defineConfig({
  title: "B4mal",
  description: "Fast, deterministic build orchestrator for monorepos",
  lang: "en-US",
  cleanUrls: true,

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/determinism" },
      { text: "Reference", link: "/reference/cli" },
      { text: "GitHub", link: "https://github.com/b4mal/b4mal" },
    ],
    sidebar: {
      "/guide/": [
        { text: "Getting Started", link: "/guide/getting-started" },
        { text: "Installation", link: "/guide/installation" },
        { text: "Configuration", link: "/guide/configuration" },
        { text: "Migration", items: [
          { text: "From Turborepo", link: "/guide/migration/turborepo" },
          { text: "From Nx", link: "/guide/migration/nx" },
          { text: "From Lerna", link: "/guide/migration/lerna" },
        ]},
      ],
      "/concepts/": [
        { text: "Determinism", link: "/concepts/determinism" },
        { text: "Resource Isolation", link: "/concepts/resource-isolation" },
        { text: "Caching", link: "/concepts/caching" },
      ],
      "/reference/": [
        { text: "CLI Commands", link: "/reference/cli" },
        { text: "Configuration Schema", link: "/reference/schema" },
        { text: "Lockfile Format", link: "/reference/b4mal-lock" },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/b4mal/b4mal" },
    ],
    search: { provider: "local" },
    footer: {
      message: "Released under the B4mal License.",
    },
  },
});
