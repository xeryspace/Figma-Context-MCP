#!/usr/bin/env node

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";

const { mkdir, writeFile } = fsp;
const DEPTH = 20;

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

  const outputDir = path.join(
    projectRoot,
    "Figma_Components",
    nodeId.replace(/[:\\/]/g, "-")
  );
  await mkdir(outputDir, { recursive: true });

  const metadata = {
    url: figmaUrl,
    fileKey,
    rootNodeId: nodeId,
    extractionDate: new Date().toISOString(),
    totalNodes: allNodes.length,
    maxDepth: allNodes.reduce((max, node) => (node.depth > max ? node.depth : max), 0),
    tool: "1-figma-crawl.js",
    version: "1.0.0",
    method: "figma_service_depth_20",
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

Run again with:

\`\`\`
node scripts/1-figma-crawl.js "${figmaUrl}"
\`\`\`
`;
  await writeFile(instructionsFile, instructionsContent, "utf8");

  console.log("\n" + "=".repeat(50));
  console.log("✅ Extraction complete!");
  console.log("=".repeat(50));
  console.log(`📊 Total nodes: ${metadata.totalNodes}`);
  console.log(`📏 Max depth: ${metadata.maxDepth}`);

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
