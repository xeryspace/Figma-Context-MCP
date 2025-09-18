# Component Tree Export

This directory contains a deterministic snapshot of the Figma component tree.

- **Source URL**: https://www.figma.com/design/TLO9Ja4fcaUF6Uvt4AE0gK/Smartgoods-Webseite?node-id=524-52174&t=881GHX8GmV9kcRVQ-4
- **Root Node**: 524:52174
- **Depth**: 20
- **Generated**: 2025-09-17T15:38:24.526Z

Files:
- `component-tree.md`: Basic tree structure
- `component-tree-enhanced.md`: Tree with inline CSS styling and asset links (PRIMARY - use this!)
- `styles-essential.json`: Compact style data with color palette and typography
- `component-lookup.json`: Quick reference table for all components
- `assets/`: Downloaded SVG and PNG files for icons and images
- `assets/manifest.json`: Asset mapping and metadata

## Usage Priority for AI/Conversion:

1. **PRIMARY**: Use `component-tree-enhanced.md` - Has all styling inline + asset links
2. **ASSETS**: Use files in `assets/` folder referenced by the tree
3. **REFERENCE**: Use `styles-essential.json` for color palette and typography
4. **LOOKUP**: Use `component-lookup.json` for finding components by ID
