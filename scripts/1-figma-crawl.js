#!/usr/bin/env node

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";

const { mkdir, writeFile, cp } = fsp;
const DEPTH = 20;
const SECONDARY_OUTPUT_ROOT =
  process.env.CONVERTER_OUTPUT_DIR || "/Users/igormacevic/Documents/Repos/Converter/ToConvert";

// Configuration for optimized output
const CONFIG = {
  MAX_JSON_NODES: 100,      // Don't include more than 100 nodes in JSON
  MAX_JSON_SIZE_KB: 500,    // Don't create JSON files larger than 500KB
  INCLUDE_RAW_DATA: false,  // Don't include raw Figma data
  ESSENTIAL_ONLY: true,     // Only include essential CSS properties
  MIN_CSS_PROPERTIES: 3,    // Minimum CSS properties to include a node
};

function isBooleanFalse(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "string") return value.toLowerCase() === "false";
  if (typeof value === "object" && value !== null) {
    if ("value" in value) return isBooleanFalse(value.value);
  }
  return false;
}

function isHiddenByComponentProperty(child, parentDoc) {
  const references = child?.componentPropertyReferences;
  const values = parentDoc?.componentPropertyValues;
  if (!references || !values) {
    return false;
  }

  const visibleRef = references.visible || references["visibleOn"];
  if (visibleRef && visibleRef in values && isBooleanFalse(values[visibleRef])) {
    return true;
  }

  for (const key of Object.keys(references)) {
    const refId = references[key];
    if (refId in values && isBooleanFalse(values[refId])) {
      if (key.toLowerCase().includes("visible") || key.toLowerCase().includes("show")) {
        return true;
      }
    }
  }

  return false;
}

function sanitizeNodeId(nodeId) {
  return nodeId.replace(/[:\\/]/g, "-");
}

async function loadEnv(envPath) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: envPath });
  } catch (error) {
    if (error && error.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
  }
}

function parseFigmaUrl(rawUrl) {
  if (!rawUrl) {
    throw new Error("A Figma URL is required");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error("Invalid Figma URL");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const fileIndex = segments.findIndex((segment) => segment === "file" || segment === "design");

  if (fileIndex === -1 || fileIndex + 1 >= segments.length) {
    throw new Error("Could not determine file key from URL");
  }

  const fileKey = segments[fileIndex + 1];
  const nodeIdParam = parsed.searchParams.get("node-id");

  if (!nodeIdParam) {
    throw new Error("Figma URL must include a node-id parameter");
  }

  const decodedNodeId = decodeURIComponent(nodeIdParam);
  const nodeId = decodedNodeId.includes(":") ? decodedNodeId : decodedNodeId.replace(/-/g, ":");

  return { fileKey, nodeId };
}

function ensureDist(projectRoot) {
  const distIndex = path.join(projectRoot, "dist", "index.js");
  if (fs.existsSync(distIndex)) {
    return;
  }

  console.log("📦 Building library (pnpm build)...");
  const buildResult = spawnSync("pnpm", ["build"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (buildResult.status !== 0) {
    throw new Error("Failed to build project. Run 'pnpm build' manually and retry.");
  }
}

function buildTreeLines(root) {
  const lines = [];
  const depthCounts = new Map();

  function traverse(current, depth, prefix, isLast) {
    depthCounts.set(depth, (depthCounts.get(depth) || 0) + 1);
    const label = `${current.name} (ID: ${current.id})`;

    if (depth === 0) {
      lines.push(`📦 ${label}`);
    } else {
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${label}`);
    }

    const children = current.children || [];
    const nextPrefix = depth === 0 ? "   " : `${prefix}${isLast ? "    " : "│   "}`;

    children.forEach((child, index) => {
      traverse(child, depth + 1, nextPrefix, index === children.length - 1);
    });
  }

  traverse(root, 0, "", true);

  const counts = [];
  for (const [depth, count] of depthCounts.entries()) {
    counts.push({ depth, count });
  }
  counts.sort((a, b) => a.depth - b.depth);

  return { lines, counts };
}

function composeMarkdown(metadata, lines, counts) {
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const rootCount = counts.find(({ depth }) => depth === 0)?.count ?? 1;
  const levelLines = counts
    .filter(({ depth }) => depth > 0)
    .map(
      ({ depth, count }) => `- **Level ${depth}**: ${count} component${count === 1 ? "" : "s"}`,
    );

  return `# Figma Components Tree

## File Information
- **Name**: ${metadata.name}
- **Last Modified**: ${metadata.lastModified}
- **Node ID**: ${metadata.rootNodeId.replace(/:/g, '-')}

## Component Structure

\`\`\`
${lines.join("\n")}
\`\`\`

## Component Summary

### Total Count
- **Root**: ${rootCount} component${rootCount === 1 ? "" : "s"}
${levelLines.join("\n")}
- **Total Components**: ${total} component${total === 1 ? "" : "s"}
`;
}

function extractStyleInfo(node) {
  const styles = [];

  // Layout mode
  if (node.layoutMode === 'VERTICAL') styles.push('flex-col');
  else if (node.layoutMode === 'HORIZONTAL') styles.push('flex-row');

  // Alignment
  if (node.primaryAxisAlignItems === 'CENTER') styles.push('center');
  else if (node.primaryAxisAlignItems === 'SPACE_BETWEEN') styles.push('space-between');
  else if (node.counterAxisAlignItems === 'CENTER') styles.push('center');
  else if (node.primaryAxisAlignItems === 'MAX') styles.push('flex-end');
  if (node.layoutAlign === 'STRETCH') styles.push('stretch');

  // Positioning
  if (node.layoutPositioning === 'ABSOLUTE') {
    styles.push('absolute');
    if (node.x !== undefined) styles.push(`x: ${Math.round(node.x)}px`);
    if (node.y !== undefined) styles.push(`y: ${Math.round(node.y)}px`);
  }

  // Size - Complete dimensions
  const width = node.absoluteBoundingBox?.width || node.size?.x;
  const height = node.absoluteBoundingBox?.height || node.size?.y;

  // Sizing modes
  if (node.layoutSizingHorizontal === 'FILL') styles.push('width: fill');
  else if (node.layoutSizingHorizontal === 'HUG') styles.push('width: hug');
  else if (width) styles.push(`${Math.round(width)}w`);

  if (node.layoutSizingVertical === 'FILL') styles.push('height: fill');
  else if (node.layoutSizingVertical === 'HUG') styles.push('height: hug');
  else if (height && (node.layoutSizingVertical === 'FIXED' || height > 50)) {
    styles.push(`${Math.round(height)}h`);
  }

  // Min/Max constraints
  if (node.minWidth !== undefined) styles.push(`min-w: ${Math.round(node.minWidth)}px`);
  if (node.maxWidth !== undefined) styles.push(`max-w: ${Math.round(node.maxWidth)}px`);
  if (node.minHeight !== undefined) styles.push(`min-h: ${Math.round(node.minHeight)}px`);
  if (node.maxHeight !== undefined) styles.push(`max-h: ${Math.round(node.maxHeight)}px`);

  // Auto-layout constraints
  if (node.layoutGrow === 1) styles.push('flex-grow');
  if (node.constraints) {
    const { horizontal, vertical } = node.constraints;
    if (horizontal && horizontal !== 'LEFT') styles.push(`h-align: ${horizontal.toLowerCase()}`);
    if (vertical && vertical !== 'TOP') styles.push(`v-align: ${vertical.toLowerCase()}`);
  }

  // Spacing
  if (node.itemSpacing) styles.push(`gap: ${Math.round(node.itemSpacing)}px`);
  if (node.paddingTop || node.paddingBottom || node.paddingLeft || node.paddingRight) {
    const paddings = [
      node.paddingTop || 0,
      node.paddingRight || 0,
      node.paddingBottom || 0,
      node.paddingLeft || 0
    ].map(p => Math.round(p));

    if (paddings.every(p => p === paddings[0])) {
      styles.push(`padding: ${paddings[0]}px`);
    } else if (paddings[0] === paddings[2] && paddings[1] === paddings[3]) {
      styles.push(`padding: ${paddings[0]}px ${paddings[1]}px`);
    } else {
      styles.push(`padding: ${paddings.join('px ')}px`);
    }
  }

  // Opacity
  if (node.opacity !== undefined && node.opacity < 1) {
    styles.push(`opacity: ${node.opacity.toFixed(2)}`);
  }

  // Blend mode
  if (node.blendMode && node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH') {
    styles.push(`blend: ${node.blendMode.toLowerCase().replace(/_/g, '-')}`);
  }

  // Overflow
  if (node.clipsContent) styles.push('overflow: hidden');
  if (node.scrollBehavior === 'SCROLLS') styles.push('overflow: auto');

  // Colors & Fills
  if (node.fills?.length > 0) {
    const fill = node.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const r = Math.round(fill.color.r * 255);
      const g = Math.round(fill.color.g * 255);
      const b = Math.round(fill.color.b * 255);
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      styles.push(`bg: ${hex.toUpperCase()}`);

      // Background opacity
      if (fill.opacity !== undefined && fill.opacity < 1) {
        styles.push(`bg-opacity: ${fill.opacity.toFixed(2)}`);
      }
    } else if (fill.type === 'GRADIENT_LINEAR') {
      const stops = fill.gradientStops || [];
      if (stops.length >= 2) {
        const startColor = stops[0].color;
        const endColor = stops[stops.length - 1].color;
        const startHex = `#${Math.round(startColor.r * 255).toString(16).padStart(2, '0')}${Math.round(startColor.g * 255).toString(16).padStart(2, '0')}${Math.round(startColor.b * 255).toString(16).padStart(2, '0')}`;
        const endHex = `#${Math.round(endColor.r * 255).toString(16).padStart(2, '0')}${Math.round(endColor.g * 255).toString(16).padStart(2, '0')}${Math.round(endColor.b * 255).toString(16).padStart(2, '0')}`;
        styles.push(`gradient: ${startHex.toUpperCase()}→${endHex.toUpperCase()}`);
      }
    }
  }

  // Text content and styling
  if (node.type === 'TEXT' && node.characters) {
    const text = node.characters.length > 50 ? node.characters.substring(0, 50) + '...' : node.characters;
    styles.push(`text: "${text}"`);

    if (node.style) {
      const fontFamily = node.style.fontFamily || 'Inter';
      const fontSize = Math.round(node.style.fontSize || 16);
      const fontWeight = node.style.fontWeight || 400;
      styles.push(`${fontFamily} ${fontWeight} ${fontSize}px`);

      // Line height with explicit units
      if (node.style.lineHeightPercentFontSize) {
        styles.push(`line-height: ${(node.style.lineHeightPercentFontSize / 100).toFixed(2)}em`);
      } else if (node.style.lineHeightPx) {
        styles.push(`line-height: ${Math.round(node.style.lineHeightPx)}px`);
      } else if (node.style.lineHeightUnit === 'AUTO') {
        styles.push(`line-height: auto`);
      }

      // Text alignment
      if (node.style.textAlignHorizontal) {
        styles.push(`text-align: ${node.style.textAlignHorizontal.toLowerCase()}`);
      }
      if (node.style.textAlignVertical) {
        styles.push(`vertical-align: ${node.style.textAlignVertical.toLowerCase()}`);
      }

      // Font variants
      if (node.style.italic) styles.push('italic');
      if (node.style.letterSpacing) {
        styles.push(`letter-spacing: ${node.style.letterSpacing.toFixed(2)}px`);
      }
      if (node.style.textDecoration) {
        styles.push(node.style.textDecoration.toLowerCase());
      }
      if (node.style.textCase) {
        styles.push(`text-transform: ${node.style.textCase.toLowerCase()}`);
      }
    }

    if (node.fills?.length > 0 && node.fills[0].type === 'SOLID') {
      const color = node.fills[0].color;
      const hex = `#${Math.round(color.r * 255).toString(16).padStart(2, '0')}${Math.round(color.g * 255).toString(16).padStart(2, '0')}${Math.round(color.b * 255).toString(16).padStart(2, '0')}`;
      styles.push(hex.toUpperCase());
    }
  }

  // Borders
  if (node.strokes?.length > 0 && node.strokeWeight) {
    const stroke = node.strokes[0];
    if (stroke.type === 'SOLID') {
      const color = stroke.color;
      const hex = `#${Math.round(color.r * 255).toString(16).padStart(2, '0')}${Math.round(color.g * 255).toString(16).padStart(2, '0')}${Math.round(color.b * 255).toString(16).padStart(2, '0')}`;
      styles.push(`border: ${Math.round(node.strokeWeight)}px ${hex.toUpperCase()}`);
    }
  }

  // Corner radius
  if (node.cornerRadius || node.rectangleCornerRadii) {
    if (node.cornerRadius) {
      styles.push(`radius: ${Math.round(node.cornerRadius)}px`);
    } else if (node.rectangleCornerRadii) {
      const radii = node.rectangleCornerRadii.map(r => Math.round(r));
      if (radii.every(r => r === radii[0])) {
        styles.push(`radius: ${radii[0]}px`);
      } else {
        styles.push(`radius: ${radii.join('px ')}px`);
      }
    }
  }

  // Shadows - capture all shadows
  if (node.effects?.length > 0) {
    const shadows = node.effects.filter(e => e.type === 'DROP_SHADOW' && e.visible !== false);
    if (shadows.length > 0) {
      const shadowStrs = shadows.map(shadow => {
        const x = Math.round(shadow.offset?.x || 0);
        const y = Math.round(shadow.offset?.y || 0);
        const blur = Math.round(shadow.radius || 0);
        const spread = Math.round(shadow.spread || 0);
        const color = shadow.color;
        const rgba = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${(color.a || 1).toFixed(2)})`;
        return spread ? `${x}px ${y}px ${blur}px ${spread}px ${rgba}` : `${x}px ${y}px ${blur}px ${rgba}`;
      });
      styles.push(`shadow: ${shadowStrs.join(', ')}`);
    }

    // Inner shadows
    const innerShadows = node.effects.filter(e => e.type === 'INNER_SHADOW' && e.visible !== false);
    if (innerShadows.length > 0) {
      const shadowStrs = innerShadows.map(shadow => {
        const x = Math.round(shadow.offset?.x || 0);
        const y = Math.round(shadow.offset?.y || 0);
        const blur = Math.round(shadow.radius || 0);
        const color = shadow.color;
        const rgba = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${(color.a || 1).toFixed(2)})`;
        return `inset ${x}px ${y}px ${blur}px ${rgba}`;
      });
      styles.push(`inner-shadow: ${shadowStrs.join(', ')}`);
    }
  }

  // Special cases - Icons and vectors
  if (node.type === 'VECTOR' || node.name?.toLowerCase().includes('icon')) {
    // Extract meaningful icon name
    const iconName = node.name
      .replace(/[_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    styles.push(`icon: ${iconName}`);

    // Indicate if SVG path data is available
    if (node.vectorPaths?.length > 0 || node.fillGeometry?.length > 0) {
      styles.push('svg-path');
    }
  }

  // Component instance properties
  if (node.componentProperties) {
    const props = Object.entries(node.componentProperties)
      .filter(([key, value]) => value && value !== 'Default')
      .map(([key, value]) => `${key}=${value}`);
    if (props.length > 0) {
      styles.push(`props: [${props.join(', ')}]`);
    }
  }

  // Instance swap preferences
  if (node.exposedInstances?.length > 0) {
    styles.push(`swappable`);
  }

  return styles.length > 0 ? ` [${styles.join(', ')}]` : '';
}

function buildEnhancedTreeLines(root, styleMap) {
  const lines = [];
  const depthCounts = new Map();

  function traverse(current, depth, prefix, isLast) {
    depthCounts.set(depth, (depthCounts.get(depth) || 0) + 1);
    const styleInfo = styleMap.get(current.id) || '';
    const label = `${current.name} (ID: ${current.id})${styleInfo}`;

    if (depth === 0) {
      lines.push(`📦 ${label}`);
    } else {
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${label}`);
    }

    const children = current.children || [];
    const nextPrefix = depth === 0 ? "   " : `${prefix}${isLast ? "    " : "│   "}`;

    children.forEach((child, index) => {
      traverse(child, depth + 1, nextPrefix, index === children.length - 1);
    });
  }

  traverse(root, 0, "", true);

  const counts = [];
  for (const [depth, count] of depthCounts.entries()) {
    counts.push({ depth, count });
  }
  counts.sort((a, b) => a.depth - b.depth);

  return { lines, counts };
}

function composeJson(metadata, tree, counts) {
  return {
    metadata: {
      url: metadata.url,
      fileKey: metadata.fileKey,
      rootNodeId: metadata.rootNodeId,
      extractionDate: metadata.extractionDate,
      totalComponents: counts.reduce((sum, item) => sum + item.count, 0),
      levels: counts.map(({ depth, count }) => ({ depth, count })),
    },
    tree,
  };
}

async function mirrorOutputDirectory(sourceDir, sanitizedNodeId) {
  if (!SECONDARY_OUTPUT_ROOT) {
    return { mirrored: false };
  }

  try {
    await mkdir(SECONDARY_OUTPUT_ROOT, { recursive: true });
    const destination = path.join(SECONDARY_OUTPUT_ROOT, sanitizedNodeId);
    await mkdir(destination, { recursive: true });
    await cp(sourceDir, destination, { recursive: true });
    return { mirrored: true, destination };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Failed to mirror output to ${SECONDARY_OUTPUT_ROOT}: ${message}`);
    return { mirrored: false, error: message };
  }
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");

  await loadEnv(path.resolve(projectRoot, ".env"));

  const figmaUrl = process.argv[2];
  if (!figmaUrl) {
    console.error('Usage: node scripts/1-figma-crawl.js "https://www.figma.com/design/..."');
    process.exit(1);
  }

  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);

  const figmaApiKey = process.env.FIGMA_API_KEY || "";
  const figmaOAuthToken = process.env.FIGMA_OAUTH_TOKEN || "";
  const useOAuth = Boolean(figmaOAuthToken);

  if (!figmaApiKey && !figmaOAuthToken) {
    console.error("FIGMA_API_KEY or FIGMA_OAUTH_TOKEN must be set (check .env)");
    process.exit(1);
  }

  ensureDist(projectRoot);

  const distEntry = pathToFileURL(path.join(projectRoot, "dist", "index.js")).href;
  const { FigmaService } = await import(distEntry);

  const figmaService = new FigmaService({
    figmaApiKey,
    figmaOAuthToken,
    useOAuth,
  });

  console.log("🚀 Figma Component Tree Crawl");
  console.log("===============================\n");
  console.log(`📁 File: ${fileKey}`);
  console.log(`🎨 Root: ${nodeId}`);
  console.log(`🔗 URL: ${figmaUrl}\n`);

  console.log("🌳 Fetching component tree...\n");

  // Fetch entire tree at once with depth for better performance
  const initialResponse = await figmaService.getRawNode(fileKey, nodeId, DEPTH);
  const rootDocument = initialResponse?.nodes?.[nodeId]?.document;

  if (!rootDocument) {
    throw new Error("Unable to locate root node in Figma response");
  }

  const lastModified = initialResponse.lastModified || new Date().toISOString();

  function expand(nodeDoc, parentDoc = null) {
    // Skip if node itself is hidden
    if (nodeDoc.visible === false) {
      console.log(`ℹ️  Skipping hidden node ${nodeDoc.id} (${nodeDoc.name})`);
      return null;
    }

    const childrenDocs = Array.isArray(nodeDoc.children) ? nodeDoc.children : [];
    const expandedChildren = [];

    for (const child of childrenDocs) {
      // Check if child is hidden by visibility property
      if (child.visible === false) {
        console.log(`ℹ️  Skipping hidden child ${child.id} (${child.name})`);
        continue;
      }

      // Check if child is hidden by component property
      if (isHiddenByComponentProperty(child, nodeDoc)) {
        console.log(`ℹ️  Skipping node ${child.id} (${child.name}) hidden by component property`);
        continue;
      }

      // Child data is already inline in the response when using depth parameter
      // Recursively expand it
      const expanded = expand(child, nodeDoc);
      if (expanded) {
        expandedChildren.push(expanded);
      }
    }

    return {
      id: nodeDoc.id,
      name: nodeDoc.name || nodeDoc.type || "Unnamed",
      type: nodeDoc.type || "UNKNOWN",
      children: expandedChildren,
    };
  }

  const tree = expand(rootDocument);
  const { lines, counts } = buildTreeLines(tree);

  const metadata = {
    name: rootDocument.name || "Unnamed Component",
    lastModified,
    rootNodeId: nodeId,
    url: figmaUrl,
    fileKey,
    extractionDate: new Date().toISOString(),
  };

  const markdown = composeMarkdown(metadata, lines, counts);

  const sanitizedNodeId = sanitizeNodeId(nodeId);
  const outputDir = path.join(projectRoot, "Figma_Components", sanitizedNodeId);
  await mkdir(outputDir, { recursive: true });

  const markdownPath = path.join(outputDir, "component-tree.md");

  await writeFile(markdownPath, markdown, "utf8");

  const instructions = `# Component Tree Export

This directory contains a deterministic snapshot of the Figma component tree.

- **Source URL**: ${figmaUrl}
- **Root Node**: ${nodeId}
- **Depth**: ${DEPTH}
- **Generated**: ${metadata.extractionDate}

Files:
- \`component-tree.md\`: human-readable tree structure
`;

  await writeFile(path.join(outputDir, "README.md"), instructions, "utf8");

  const mirrorResult = await mirrorOutputDirectory(outputDir, sanitizedNodeId);
  if (mirrorResult.mirrored) {
    console.log(`🗂️  Mirrored output to ${mirrorResult.destination}`);
  }

  console.log("\n" + "=".repeat(40));
  console.log("✅ Tree extraction complete!");
  console.log("=".repeat(40));
  counts.forEach(({ depth, count }) => {
    console.log(`Level ${depth}: ${count} component${count === 1 ? "" : "s"}`);
  });
  console.log(`Total: ${counts.reduce((sum, item) => sum + item.count, 0)} components`);
  console.log(`\n📄 Markdown: ${markdownPath}`);

  // Enhancement phase
  console.log("\n🎨 Enhancing tree with styling information...");

  // Collect strategic nodes for enhancement
  const nodesToEnhance = new Set();

  function collectStrategicNodes(node, depth = 0) {
    // Always enhance root and first 2 levels
    if (depth <= 2) {
      nodesToEnhance.add(node.id);
    }

    // Enhance text nodes
    if (node.type === 'TEXT' || node.name?.toLowerCase().includes('typography')) {
      nodesToEnhance.add(node.id);
    }

    // Enhance key UI containers
    if (node.name?.toLowerCase().includes('menu') ||
        node.name?.toLowerCase().includes('frame') ||
        node.name?.toLowerCase().includes('button') ||
        node.name?.toLowerCase().includes('number')) {
      nodesToEnhance.add(node.id);
    }

    // Recursively collect from children
    if (node.children) {
      node.children.forEach(child => collectStrategicNodes(child, depth + 1));
    }
  }

  collectStrategicNodes(tree);
  console.log(`📊 Enhancing ${nodesToEnhance.size} strategic nodes...`);

  // Fetch detailed data for strategic nodes
  const styleMap = new Map();
  const enhancedNodes = new Map();

  for (const nodeId of nodesToEnhance) {
    try {
      const response = await figmaService.getRawNode(fileKey, nodeId, 2);
      const nodeData = response?.nodes?.[nodeId]?.document;
      if (nodeData) {
        enhancedNodes.set(nodeId, nodeData);
        const styleInfo = extractStyleInfo(nodeData);
        if (styleInfo) {
          styleMap.set(nodeId, styleInfo);
        }
      }
    } catch (error) {
      console.log(`⚠️  Could not enhance node ${nodeId}`);
    }
  }

  // Build enhanced tree
  function enhanceTree(node) {
    const enhanced = enhancedNodes.get(node.id);
    if (enhanced) {
      // Merge enhanced data
      node.type = enhanced.type || node.type;
      node.name = enhanced.name || node.name;
    }

    if (node.children) {
      node.children.forEach(child => enhanceTree(child));
    }

    return node;
  }

  const enhancedTree = enhanceTree(JSON.parse(JSON.stringify(tree)));
  const { lines: enhancedLines, counts: enhancedCounts } = buildEnhancedTreeLines(enhancedTree, styleMap);

  // Create enhanced markdown
  const enhancedMarkdown = `# Figma Components Tree (Enhanced)

## File Information
- **Name**: ${metadata.name}
- **Last Modified**: ${metadata.lastModified}
- **Node ID**: ${metadata.rootNodeId.replace(/:/g, '-')}
- **Enhanced**: ${new Date().toISOString()}

## Component Structure with Styling

\`\`\`
${enhancedLines.join("\n")}
\`\`\`

## Component Summary

### Total Count
${counts.map(({ depth, count }) => `- **Level ${depth}**: ${count} component${count === 1 ? "" : "s"}`).join("\n")}
- **Total Components**: ${counts.reduce((sum, item) => sum + item.count, 0)} components

## CSS Properties Legend

- **Layout**: flex-row, flex-col, center, space-between, flex-end
- **Size**: WxH in px, fill-width
- **Spacing**: gap, padding
- **Colors**: bg (background), gradient, hex colors for text
- **Typography**: Font Family, Weight, Size, line-height
- **Effects**: shadow, border, radius
- **Content**: text content in quotes
`;

  const enhancedPath = path.join(outputDir, "component-tree-enhanced.md");
  await writeFile(enhancedPath, enhancedMarkdown, "utf8");

  // Essential style data (compact)
  const essentialStyles = {};
  const colorPalette = new Set();
  const typography = new Map();

  // Build essential style data for each node
  function buildEssentialStyleData(node, depth = 0) {
    const nodeStyles = styleMap.get(node.id);
    const enhancedData = enhancedNodes.get(node.id);

    if (nodeStyles || enhancedData) {
      // Only store what's needed for HTML/CSS generation
      const essential = {
        name: node.name,
        type: node.type,
        styles: nodeStyles || ''
      };

      // Only add CSS if it has meaningful properties
      if (enhancedData) {
        const css = extractCSSProperties(enhancedData);
        if (Object.keys(css).length >= CONFIG.MIN_CSS_PROPERTIES) {
          essential.css = css;
        }

        // Collect colors
        if (enhancedData.fills?.length > 0) {
          enhancedData.fills.forEach(fill => {
            if (fill.type === 'SOLID' && fill.color) {
              const hex = rgbToHex(fill.color);
              colorPalette.add(hex);
            }
          });
        }

        // Collect typography
        if (node.type === 'TEXT' && enhancedData.style) {
          const fontKey = `${enhancedData.style.fontFamily || 'Inter'} ${enhancedData.style.fontWeight || 400} ${Math.round(enhancedData.style.fontSize || 16)}px`;
          typography.set(fontKey, {
            family: enhancedData.style.fontFamily || 'Inter',
            weight: enhancedData.style.fontWeight || 400,
            size: Math.round(enhancedData.style.fontSize || 16)
          });
        }

        // Only add text content for TEXT nodes
        if (node.type === 'TEXT' && enhancedData.characters) {
          essential.content = enhancedData.characters;
        }
      }

      essentialStyles[node.id] = essential;
    }

    if (node.children) {
      node.children.forEach(child => buildEssentialStyleData(child, depth + 1));
    }
  }

  // Helper function to convert RGB to hex
  function rgbToHex(color) {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  // Extract CSS properties for JSON export
  function extractCSSProperties(node) {
    const css = {};

    // Display and layout
    if (node.layoutMode === 'VERTICAL') {
      css.display = 'flex';
      css.flexDirection = 'column';
    } else if (node.layoutMode === 'HORIZONTAL') {
      css.display = 'flex';
      css.flexDirection = 'row';
    }

    // Dimensions
    const width = node.absoluteBoundingBox?.width || node.size?.x;
    const height = node.absoluteBoundingBox?.height || node.size?.y;
    if (width) css.width = `${Math.round(width)}px`;
    if (height) css.height = `${Math.round(height)}px`;

    // Spacing
    if (node.itemSpacing) css.gap = `${Math.round(node.itemSpacing)}px`;
    if (node.paddingTop) css.paddingTop = `${Math.round(node.paddingTop)}px`;
    if (node.paddingRight) css.paddingRight = `${Math.round(node.paddingRight)}px`;
    if (node.paddingBottom) css.paddingBottom = `${Math.round(node.paddingBottom)}px`;
    if (node.paddingLeft) css.paddingLeft = `${Math.round(node.paddingLeft)}px`;

    // Colors
    if (node.fills?.length > 0) {
      const fill = node.fills[0];
      if (fill.type === 'SOLID' && fill.color) {
        const r = Math.round(fill.color.r * 255);
        const g = Math.round(fill.color.g * 255);
        const b = Math.round(fill.color.b * 255);
        css.backgroundColor = `rgb(${r}, ${g}, ${b})`;
        if (fill.opacity !== undefined && fill.opacity < 1) {
          css.backgroundOpacity = fill.opacity;
        }
      }
    }

    // Text styles
    if (node.type === 'TEXT' && node.style) {
      css.fontFamily = node.style.fontFamily || 'Inter';
      css.fontSize = `${Math.round(node.style.fontSize || 16)}px`;
      css.fontWeight = node.style.fontWeight || 400;
      if (node.style.lineHeightPercentFontSize) {
        css.lineHeight = (node.style.lineHeightPercentFontSize / 100).toFixed(2);
      }
      if (node.style.letterSpacing) {
        css.letterSpacing = `${node.style.letterSpacing.toFixed(2)}px`;
      }
      if (node.style.textAlignHorizontal) {
        css.textAlign = node.style.textAlignHorizontal.toLowerCase();
      }
    }

    // Border radius
    if (node.cornerRadius) {
      css.borderRadius = `${Math.round(node.cornerRadius)}px`;
    } else if (node.rectangleCornerRadii) {
      const radii = node.rectangleCornerRadii.map(r => `${Math.round(r)}px`);
      css.borderRadius = radii.join(' ');
    }

    // Effects
    if (node.opacity !== undefined && node.opacity < 1) {
      css.opacity = node.opacity;
    }

    if (node.effects?.length > 0) {
      const shadows = node.effects
        .filter(e => e.type === 'DROP_SHADOW' && e.visible !== false)
        .map(shadow => {
          const x = Math.round(shadow.offset?.x || 0);
          const y = Math.round(shadow.offset?.y || 0);
          const blur = Math.round(shadow.radius || 0);
          const color = shadow.color;
          const rgba = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${(color.a || 1).toFixed(2)})`;
          return `${x}px ${y}px ${blur}px ${rgba}`;
        });
      if (shadows.length > 0) {
        css.boxShadow = shadows.join(', ');
      }
    }

    return css;
  }

  buildEssentialStyleData(enhancedTree);

  // Create component lookup table for quick reference
  const componentLookup = {};
  function buildLookup(node, path = '') {
    const currentPath = path ? `${path} > ${node.name}` : node.name;
    componentLookup[node.id] = {
      path: currentPath,
      type: node.type,
      styles: styleMap.get(node.id) || '',
      parent: path || null
    };

    if (node.children) {
      node.children.forEach(child => buildLookup(child, currentPath));
    }
  }
  buildLookup(enhancedTree);

  // Write essential styles JSON (compact)
  const essentialData = {
    metadata: {
      ...metadata,
      enhancementDate: new Date().toISOString(),
      totalNodes: Object.keys(essentialStyles).length
    },
    components: essentialStyles,
    colorPalette: Array.from(colorPalette).sort(),
    typography: Array.from(typography.values())
  };

  const essentialJsonPath = path.join(outputDir, "styles-essential.json");
  await writeFile(essentialJsonPath, JSON.stringify(essentialData, null, 2), "utf8");

  // Write component lookup JSON
  const lookupJsonPath = path.join(outputDir, "component-lookup.json");
  await writeFile(lookupJsonPath, JSON.stringify(componentLookup, null, 2), "utf8");

  console.log(`\n✨ Enhanced tree created!`);
  console.log(`📄 Enhanced: ${enhancedPath}`);
  console.log(`📦 Essential Styles: ${essentialJsonPath}`);
  console.log(`🔍 Component Lookup: ${lookupJsonPath}`);
  console.log(`\n🎨 Colors found: ${colorPalette.size}`);
  console.log(`🔤 Typography variants: ${typography.size}`);

  // Update README
  const updatedInstructions = `# Component Tree Export

This directory contains a deterministic snapshot of the Figma component tree.

- **Source URL**: ${figmaUrl}
- **Root Node**: ${nodeId}
- **Depth**: ${DEPTH}
- **Generated**: ${metadata.extractionDate}

Files:
- \`component-tree.md\`: Basic tree structure
- \`component-tree-enhanced.md\`: Tree with inline CSS styling (PRIMARY - use this!)
- \`styles-essential.json\`: Compact style data with color palette and typography
- \`component-lookup.json\`: Quick reference table for all components

## Usage Priority for AI/Conversion:

1. **PRIMARY**: Use \`component-tree-enhanced.md\` - Has all styling inline
2. **REFERENCE**: Use \`styles-essential.json\` for color palette and typography
3. **LOOKUP**: Use \`component-lookup.json\` for finding components by ID
`;

  await writeFile(path.join(outputDir, "README.md"), updatedInstructions, "utf8");

  // Mirror enhanced files if needed
  if (mirrorResult.mirrored) {
    const enhancedMirrorPath = path.join(mirrorResult.destination, "component-tree-enhanced.md");
    const essentialMirrorPath = path.join(mirrorResult.destination, "styles-essential.json");
    const lookupMirrorPath = path.join(mirrorResult.destination, "component-lookup.json");
    await writeFile(enhancedMirrorPath, enhancedMarkdown, "utf8");
    await writeFile(essentialMirrorPath, JSON.stringify(essentialData, null, 2), "utf8");
    await writeFile(lookupMirrorPath, JSON.stringify(componentLookup, null, 2), "utf8");
    await writeFile(path.join(mirrorResult.destination, "README.md"), updatedInstructions, "utf8");
  }
}

main().catch((error) => {
  console.error("❌ Error:", error.message || error);
  process.exit(1);
});
