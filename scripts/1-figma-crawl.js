#!/usr/bin/env node

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";

const { mkdir, writeFile } = fsp;
const DEPTH = 20;
const VECTOR_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "ELLIPSE",
  "LINE",
  "REGULAR_POLYGON",
  "POLYGON",
]);

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

function slugify(value, fallback) {
  const normalized = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function uniqueFileName(baseName, ext, usedNames) {
  let candidate = `${baseName}.${ext}`;
  let counter = 1;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${counter}.${ext}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function collectAssetEntries(rawDocument) {
  const entries = new Map();
  const usedNames = new Set();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    const sanitizedId = (node.id || "node").replace(/[^a-zA-Z0-9]+/g, "-");
    const baseName = slugify(node.name, `node-${sanitizedId}`);

    if (Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        if (fill && fill.type === "IMAGE" && fill.visible !== false && fill.imageRef) {
          const key = `fill:${fill.imageRef}`;
          if (!entries.has(key)) {
            const fileName = uniqueFileName(baseName, "png", usedNames);
            entries.set(key, {
              key,
              type: "fill",
              imageRef: fill.imageRef,
              fileName,
              nodeIds: new Set(),
            });
          }
          entries.get(key).nodeIds.add(node.id);
        }
      }
    }

    if (VECTOR_TYPES.has(node.type) && !entries.has(`render:${node.id}`)) {
      const ext = node.type === "IMAGE" ? "png" : "svg";
      const fileName = uniqueFileName(baseName, ext, usedNames);
      entries.set(`render:${node.id}`, {
        key: `render:${node.id}`,
        type: "render",
        nodeId: node.id,
        fileName,
        nodeIds: new Set([node.id]),
      });
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  visit(rawDocument);
  return Array.from(entries.values());
}

function orderDownloadItems(entries) {
  const imageRefEntries = entries.filter((entry) => entry.type === "fill");
  const renderEntries = entries.filter((entry) => entry.type === "render");

  const svgEntries = renderEntries.filter((entry) => entry.fileName.toLowerCase().endsWith(".svg"));
  const otherRenderEntries = renderEntries.filter(
    (entry) => !entry.fileName.toLowerCase().endsWith(".svg"),
  );

  return [...imageRefEntries, ...otherRenderEntries, ...svgEntries];
}

function buildAssetRecords(entries, downloads, assetFolderName) {
  const entryByFileName = new Map(entries.map((entry) => [entry.fileName, entry]));
  const assetMap = new Map();

  for (const result of downloads) {
    if (!result) continue;
    const fileName = path.basename(result.filePath);
    const entry = entryByFileName.get(fileName);
    if (!entry) continue;

    const relativePath = path.posix.join(assetFolderName, fileName);
    const usage = entry.type === "fill" ? "background" : "img";
    const assetInfo = {
      path: relativePath,
      type: entry.type,
      usage,
      width: result.finalDimensions.width,
      height: result.finalDimensions.height,
      wasCropped: result.wasCropped,
    };

    for (const nodeId of entry.nodeIds) {
      const list = assetMap.get(nodeId) || [];
      list.push(assetInfo);
      assetMap.set(nodeId, list);
    }
  }

  return assetMap;
}

function mergeAssetInfo(targetNode, assetMap) {
  if (!targetNode) return;
  const assets = assetMap.get(targetNode.id);
  if (assets && assets.length > 0) {
    targetNode.assets = assets;
  }
  if (Array.isArray(targetNode.children)) {
    for (const child of targetNode.children) {
      mergeAssetInfo(child, assetMap);
    }
  }
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

function extractAllNodes(node, depth = 0, nodes = []) {
  if (!node || typeof node !== "object") {
    return nodes;
  }

  const nodeInfo = {
    id: node.id || `unknown_${nodes.length}`,
    name: node.name || `Node ${nodes.length}`,
    type: node.type || "UNKNOWN",
    depth,
    componentId: node.componentId ?? null,
    text: node.text ?? null,
    hasChildren: Array.isArray(node.children) && node.children.length > 0,
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };

  if (Object.prototype.hasOwnProperty.call(node, "layout")) nodeInfo.layout = node.layout;
  if (Object.prototype.hasOwnProperty.call(node, "fills")) nodeInfo.fills = node.fills;
  if (Object.prototype.hasOwnProperty.call(node, "effects")) nodeInfo.effects = node.effects;
  if (Object.prototype.hasOwnProperty.call(node, "strokes")) nodeInfo.strokes = node.strokes;
  if (Object.prototype.hasOwnProperty.call(node, "strokeWeight")) nodeInfo.strokeWeight = node.strokeWeight;
  if (Object.prototype.hasOwnProperty.call(node, "borderRadius")) nodeInfo.borderRadius = node.borderRadius;
  if (Object.prototype.hasOwnProperty.call(node, "textStyle")) nodeInfo.textStyle = node.textStyle;

  nodes.push(nodeInfo);

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      extractAllNodes(child, depth + 1, nodes);
    }
  }

  return nodes;
}

function summariseTypes(nodes) {
  const counts = {};
  for (const node of nodes) {
    counts[node.type] = (counts[node.type] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
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
  const { FigmaService, simplifyRawFigmaObject, allExtractors } = await import(distEntry);

  const figmaService = new FigmaService({
    figmaApiKey,
    figmaOAuthToken,
    useOAuth,
  });

  console.log("🚀 Universal Figma Tree Crawler");
  console.log("================================\n");

  console.log(`📁 File: ${fileKey}`);
  console.log(`🎨 Root: ${nodeId}`);
  console.log(`🔗 URL: ${figmaUrl}\n`);

  console.log(`🌳 Fetching depth=${DEPTH} via get_figma_data pipeline...\n`);

  const rawResponse = await figmaService.getRawNode(fileKey, nodeId, DEPTH);
  const simplified = simplifyRawFigmaObject(rawResponse, allExtractors, { maxDepth: DEPTH });

  const allNodes = [];
  const simplifiedRoots = Array.isArray(simplified.nodes) ? simplified.nodes : [];
  for (const rootNode of simplifiedRoots) {
    extractAllNodes(rootNode, 0, allNodes);
  }

  if (allNodes.length === 0) {
    const rawNode = rawResponse?.nodes?.[nodeId]?.document;
    if (rawNode) {
      extractAllNodes(rawNode, 0, allNodes);
    }
  }

  if (allNodes.length === 0) {
    console.warn("⚠️ No nodes were returned. Check the node-id and authentication.");
  }

  const sanitizedNodeId = nodeId.replace(/[:\\/]/g, "-");
  const outputDir = path.join(projectRoot, "Figma_Components", sanitizedNodeId);
  await mkdir(outputDir, { recursive: true });
  const assetsDir = path.join(outputDir, "assets");
  const assetFolderName = path.basename(assetsDir);

  let assetMap = new Map();
  let assetCount = 0;
  const rawDocument = rawResponse?.nodes?.[nodeId]?.document;

  if (rawDocument) {
    const assetEntries = collectAssetEntries(rawDocument);
    if (assetEntries.length > 0) {
      console.log(`🖼️ Preparing ${assetEntries.length} asset(s) for download...`);
      await mkdir(assetsDir, { recursive: true });
      const orderedEntries = orderDownloadItems(assetEntries);
      const downloadItems = orderedEntries.map((entry) =>
        entry.type === "fill"
          ? { imageRef: entry.imageRef, fileName: entry.fileName }
          : { nodeId: entry.nodeId, fileName: entry.fileName },
      );

      const downloads = await figmaService.downloadImages(
        fileKey,
        assetsDir,
        downloadItems,
        { pngScale: 2 },
      );

      assetMap = buildAssetRecords(orderedEntries, downloads, assetFolderName);
      assetCount = downloads.length;

      for (const node of allNodes) {
        const assets = assetMap.get(node.id);
        if (assets && assets.length > 0) {
          node.assets = assets;
        }
      }

      if (Array.isArray(simplified.nodes)) {
        for (const rootNode of simplified.nodes) {
          mergeAssetInfo(rootNode, assetMap);
        }
      }
    } else {
      console.log("ℹ️ No assets detected for this selection.");
    }
  } else {
    console.warn("⚠️ Could not resolve raw node document; skipping asset extraction.");
  }

  const metadata = {
    url: figmaUrl,
    fileKey,
    rootNodeId: nodeId,
    extractionDate: new Date().toISOString(),
    totalNodes: allNodes.length,
    maxDepth: allNodes.reduce((max, node) => (node.depth > max ? node.depth : max), 0),
    tool: "1-figma-crawl.js",
    version: "1.1.0",
    method: "figma_service_depth_20",
    assetsDownloaded: assetCount,
    assetsDirectory: assetCount > 0 ? path.posix.join(sanitizedNodeId, assetFolderName) : null,
  };

  const output = {
    metadata,
    nodes: allNodes,
    simplified,
  };

  const outputFile = path.join(outputDir, "deterministic_nodes.json");
  await writeFile(outputFile, JSON.stringify(output, null, 2), "utf8");

  const instructionsFile = path.join(outputDir, "MCP_INTEGRATION.md");
  const instructionsContent = `# MCP Integration Notes

This crawl uses the repository's built-in \`get_figma_data\` pipeline:

- Depth: ${DEPTH}
- File key: ${fileKey}
- Root node: ${nodeId}
- Auth: ${useOAuth ? "OAuth bearer" : "Personal access token"}

Ensure \`FIGMA_API_KEY\` or \`FIGMA_OAUTH_TOKEN\` is set before running:

\`\`\`
FIGMA_API_KEY=your-figma-token
# or
FIGMA_OAUTH_TOKEN=your-oauth-token
\`\`\`

Assets downloaded automatically into \`${path.posix.join(sanitizedNodeId, assetFolderName)}\`.

Run again with the same command if you need to refresh the data.
`;
  await writeFile(instructionsFile, instructionsContent, "utf8");

  console.log("\n" + "=".repeat(50));
  console.log("✅ Extraction complete!");
  console.log("=".repeat(50));
  console.log(`📊 Total nodes: ${metadata.totalNodes}`);
  console.log(`📏 Max depth: ${metadata.maxDepth}`);
  if (assetCount > 0) {
    const assetDisplayPath = path.relative(projectRoot, path.join(outputDir, assetFolderName));
    console.log(`🖼️ Assets downloaded: ${assetCount} → ${assetDisplayPath}`);
  } else {
    console.log("🖼️ Assets downloaded: 0");
  }

  const typeSummary = summariseTypes(allNodes);
  if (typeSummary.length > 0) {
    console.log("\n📈 Node types:");
    for (const [type, count] of typeSummary) {
      console.log(`  ${type}: ${count}`);
    }
  }

  console.log(`\n📄 Output saved to: ${outputFile}`);
  console.log(`📄 Integration notes: ${instructionsFile}`);
  console.log("\n✨ Script works with any Figma URL containing a node-id.\n");
}

main().catch((error) => {
  console.error("❌ Error:", error.message || error);
  process.exit(1);
});
