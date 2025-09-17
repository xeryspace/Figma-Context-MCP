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
- **Node ID**: ${metadata.rootNodeId}

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
}

main().catch((error) => {
  console.error("❌ Error:", error.message || error);
  process.exit(1);
});
