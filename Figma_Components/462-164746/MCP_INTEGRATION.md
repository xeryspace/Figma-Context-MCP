# MCP Integration Notes

This crawl uses the repository's built-in `get_figma_data` pipeline:

- Depth: 20
- File key: TLO9Ja4fcaUF6Uvt4AE0gK
- Root node: 462:164746
- Auth: Personal access token

Ensure `FIGMA_API_KEY` or `FIGMA_OAUTH_TOKEN` is set before running:

```
FIGMA_API_KEY=your-figma-token
# or
FIGMA_OAUTH_TOKEN=your-oauth-token
```

Run again with:

```
node scripts/1-figma-crawl.js "https://www.figma.com/design/TLO9Ja4fcaUF6Uvt4AE0gK/Smartgoods-Webseite?node-id=462-164746&m=dev"
```
