#!/usr/bin/env node
/**
 * CLI 入口
 *
 * 用法:
 *   swagger-tools                                   自动加载 swagger-tools.config.mjs 执行生成
 *   swagger-tools --config <config.mjs>             手动指定配置文件
 *   swagger-tools <swagger.json> [output.json]      解析并输出摘要/JSON
 *   swagger-tools --help                            显示帮助
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSwaggerSpec } from './parser.ts';
import { generateFetchCode, generateCurlCode, generateAxiosCode } from './generator.ts';
import type { SwaggerSpec, ParsedInstance, ParsedApiInfo } from './types.ts';

// ============================================================
// 配置文件类型 & 加载
// ============================================================

// 配置文件支持的字段（与命令行选项完全对应）
interface GenerateConfig {
  /** [二选一] 本地 Swagger 规范文件路径 */
  file?: string;
  /** [二选一] 远程 Swagger 规范 URL */
  url?: string;
  /** [二选一] 按标签 (tag) 生成各分组下所有接口的代码（数组，每个 tag 生成一个文件） */
  tags?: string[];
  /** [二选一] 按接口路径生成（支持部分路径匹配，数组，每个路径生成一个文件） */
  paths?: string[];
  /** [可选] 输出目录。按 tag 生成时写入 <dir>/<tag>.ts */
  output?: string;
  /** [可选] 基础 URL。为空时从规范文档中推断 */
  baseUrl?: string;
  /** [可选] 输出格式: curl / fetch / axios。默认 fetch */
  format?: 'curl' | 'fetch' | 'axios';
  /** [可选] 是否生成 TypeScript 类型定义，默认 true */
  types?: boolean;
  /** [可选] 是否生成注释，默认 true */
  comments?: boolean;
}

/** 已知的配置文件候选名（按优先级从高到低） */
const CONFIG_CANDIDATES = [
  'swagger-tools.config.mjs',
  'swagger-tools.config.js',
  'swagger-tools.config.json',
  '.swagger-toolsrc',
  '.swagger-toolsrc.json',
];

/** 将 string[] | undefined 归一化为数组 */
function toArray(value: string[] | undefined): string[] {
  return value ?? [];
}

/** 补全配置默认值 */
function fillConfigDefaults(config: Partial<GenerateConfig>): GenerateConfig {
  return {
    file: config.file,
    url: config.url,
    tags: toArray(config.tags),
    paths: toArray(config.paths),
    output: config.output,
    baseUrl: config.baseUrl ?? '',
    format: config.format ?? 'fetch',
    types: config.types ?? true,
    comments: config.comments ?? true,
  };
}

/** 校验配置文件是否指定了规范来源 */
function validateSpecSource(cfg: Partial<GenerateConfig>, configPath: string): void {
  const hasFile = !!cfg.file;
  const hasUrl = !!cfg.url;
  if (!hasFile && !hasUrl) {
    console.error(`配置文件需指定 "file" 或 "url": ${configPath}`);
    process.exit(1);
  }
}

/** 加载 JS 配置文件（通过动态 import） */
async function loadJsConfig(filePath: string): Promise<GenerateConfig> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`配置文件不存在: ${resolved}`);
    process.exit(1);
  }
  try {
    const url = pathToFileURL(resolved).href;
    const mod = await import(url);
    const cfg: Partial<GenerateConfig> = mod.default ?? mod;
    validateSpecSource(cfg, resolved);
    return fillConfigDefaults(cfg);
  } catch (err) {
    console.error(`配置文件加载失败: ${resolved}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** 加载 JSON 配置文件 */
function loadJsonConfig(filePath: string): GenerateConfig {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`配置文件不存在: ${resolved}`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const cfg = JSON.parse(raw) as Partial<GenerateConfig>;
    validateSpecSource(cfg, resolved);
    return fillConfigDefaults(cfg);
  } catch (err) {
    console.error(`配置文件解析失败: ${resolved}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** 根据扩展名自动选择加载方式 */
async function loadConfigFile(filePath: string): Promise<GenerateConfig> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js' || ext === '.mjs') {
    return loadJsConfig(filePath);
  }
  return loadJsonConfig(filePath);
}

/** 在当前目录自动检测配置文件 */
async function detectConfigFile(): Promise<string | null> {
  for (const name of CONFIG_CANDIDATES) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ============================================================
// 入口
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  // 无参数时尝试自动加载配置文件
  if (args.length === 0) {
    const configPath = await detectConfigFile();
    if (configPath) {
      console.log(`自动加载配置文件: ${configPath}\n`);
      return runWithConfig(await loadConfigFile(configPath));
    }
    printHelp();
    process.exit(1);
  }

  // 判断子命令
  if (args[0] === '--config') {
    const configPath = args[1];
    if (!configPath) {
      console.error('请指定配置文件路径，例如: swagger-tools --config my-config.js');
      process.exit(1);
    }
    return runWithConfig(await loadConfigFile(configPath));
  }
  if (args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  // 默认当作解析命令
  handleParse(args);
}

// ============================================================
// 帮助
// ============================================================

function printHelp() {
  console.log(`swagger-tools - Swagger/OpenAPI 解析与代码生成工具

用法:
  swagger-tools                             自动加载 swagger-tools.config.mjs 执行生成
  swagger-tools --config <config.mjs>       使用指定配置文件执行生成
  swagger-tools <swagger.json> [output]     解析并输出摘要/JSON
  swagger-tools --help                      显示帮助

配置文件选项（swagger-tools.config.mjs）:
  file       [二选一] 本地 Swagger 规范文件路径
  url        [二选一] 远程 Swagger 规范 URL
  tags       [二选一] 按标签生成各分组下所有接口的代码（数组，每个 tag 一个文件）
  paths      [二选一] 按接口路径生成（支持部分路径匹配，数组，每个路径一个文件）
  output     [可选] 输出目录。按 tag 生成时写入 <dir>/<tag>.ts
  baseUrl    [可选] 基础 URL
  format     [可选] 输出格式: curl / fetch / axios（默认 fetch）
  types      [可选] 生成 TypeScript 类型定义（默认 true）
  comments   [可选] 生成注释（默认 true）

示例:
  swagger-tools                              # 使用配置文件
  swagger-tools api.json                     # 解析并查看摘要
  swagger-tools --config ./my-config.mjs     # 指定配置文件`);
}

// ============================================================
// 配置文件执行入口
// ============================================================

/** 根据配置文件执行生成 */
async function runWithConfig(config: GenerateConfig): Promise<void> {
  // 解析规范来源：本地文件或远程 URL
  let spec: SwaggerSpec;
  if (config.url) {
    spec = await fetchSpec(config.url);
  } else {
    spec = loadSpecFile(config.file!);
  }
  const instance = parseSwaggerSpec(spec);

  // 解析配置中的选项
  const format = config.format ?? 'fetch';
  const baseUrl = config.baseUrl ?? '';
  const genTypes = config.types ?? true;
  const genComments = config.comments ?? true;
  const outDir = config.output ?? null;

  const tags = config.tags ?? [];
  const paths = config.paths ?? [];

  // 按 tag 优先（每个 tag 生成一个文件）
  if (tags.length > 0) {
    for (const t of tags) {
      handleGenerateByTag(instance, t, { format, baseUrl, types: genTypes, comments: genComments, outDir });
    }
    return;
  }

  // 按路径（所有路径合并写入同一个文件）
  if (paths.length > 0) {
    handleGenerateByPaths(instance, paths, { format, baseUrl, types: genTypes, comments: genComments, outDir });
    return;
  }

  console.error('配置文件需指定 "tags" 或 "paths"（非空数组）');
  process.exit(1);
}

// ============================================================
// 加载 Swagger 规范文件（本地 / 远程）
// ============================================================

/** 从本地文件加载并解析 Swagger 规范 */
function loadSpecFile(filePath: string): SwaggerSpec {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`文件不存在: ${resolved}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  return JSON.parse(raw);
}

/** 从远程 URL 下载并解析 Swagger 规范 */
async function fetchSpec(url: string): Promise<SwaggerSpec> {
  console.log(`正在从远程获取 Swagger 规范: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`下载失败: ${url} (HTTP ${response.status})`);
    process.exit(1);
  }
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    console.error('远程返回的内容不是有效的 JSON');
    process.exit(1);
  }
}

// ============================================================
// 解析命令
// ============================================================

function handleParse(args: string[]) {
  const spec = loadSpecFile(args[0]!);
  const instance = parseSwaggerSpec(spec);

  console.log('=== Swagger 解析结果 ===');
  console.log(`标题: ${instance.title}`);
  console.log(`版本: ${instance.version}`);
  console.log(`OAS 版本: ${instance.groupVersion}`);
  console.log(`BasePath: ${instance.basePath}`);
  console.log(`Host: ${instance.host}`);
  console.log(`Definitions 数量: ${instance.definitions.length}`);
  console.log(`接口数量: ${instance.paths.length}`);
  console.log(`Tag 分组数: ${instance.tags.length}`);
  console.log(`Security 方案数: ${instance.securityArrs.length}`);

  console.log('\n--- Tag 分组 ---');
  for (const tag of instance.tags) {
    console.log(`  [${tag.name}] ${tag.description} - 接口数: ${tag.childrens.length}`);
  }

  console.log('\n--- Definitions ---');
  for (const def of instance.definitions) {
    console.log(`  ${def.name}: ${def.properties.length} 个属性`);
  }

  console.log('\n--- 接口列表 ---');
  for (const api of instance.paths) {
    console.log(`  [${api.methodType}] ${api.url} - ${api.summary}`);
    for (const param of api.parameters) {
      console.log(`    参数: ${param.name} (${param.in}/${param.type}) ${param.require ? '[必填]' : ''}`);
    }
    for (const resp of api.responseCodes) {
      console.log(`    响应 ${resp.code}: ${resp.description} ${resp.schema ? `=> ${resp.schema}` : ''}`);
    }
  }

  if (args[1]) {
    const outPath = path.resolve(args[1]);
    fs.writeFileSync(outPath, JSON.stringify(instance, null, 2), 'utf-8');
    console.log(`\n解析结果已写入: ${outPath}`);
  }
}

/** 根据路径查找接口（支持部分匹配），未找到返回 null */
function findApiByPath(instance: ParsedInstance, searchPath: string): ParsedApiInfo | null {
  let api = instance.paths.find((p) => p.url === searchPath);
  if (!api) api = instance.paths.find((p) => p.url.includes(searchPath));
  if (!api) {
    console.error(`未找到路径: ${searchPath}`);
    console.error(`可用路径 (前10条):`);
    instance.paths.slice(0, 10).forEach((p) => console.error(`  [${p.methodType}] ${p.url}`));
    process.exitCode = 1;
    return null;
  }
  return api;
}

/** 按路径列表生成：所有匹配的接口合并写入同一个文件，重复的类型定义自动去重 */
function handleGenerateByPaths(
  instance: ParsedInstance, searchPaths: string[],
  options: { format: 'curl' | 'fetch' | 'axios'; baseUrl: string; types: boolean; comments: boolean; outDir: string | null },
): void {
  const apis: ParsedApiInfo[] = [];
  for (const p of searchPaths) {
    const api = findApiByPath(instance, p);
    if (api) apis.push(api);
  }

  if (apis.length === 0) {
    console.error('未匹配到任何接口');
    process.exitCode = 1;
    return;
  }

  console.log(`匹配到 ${apis.length} 个接口\n`);

  // 无输出目录时直接打印（接口之间用分隔线分隔）
  if (!options.outDir) {
    for (const api of apis) {
      const code = generateSingleApiCode(api, instance, options);
      console.log(code);
      console.log('\n' + '='.repeat(72) + '\n');
    }
    return;
  }

  // 所有接口代码写入同一个文件，重复的类型定义自动去重
  const outDirPath = path.resolve(options.outDir);
  fs.mkdirSync(outDirPath, { recursive: true });
  const filePath = path.join(outDirPath, 'paths.ts');

  const seenTypes = new Set<string>();
  const allLines: string[] = [];
  let skipDepth = 0;
  for (const api of apis) {
    const code = generateSingleApiCode(api, instance, options);
    for (const line of code.split('\n')) {
      if (skipDepth > 0) {
        if (/[{]/.test(line)) skipDepth++;
        if (/[}]/.test(line)) skipDepth--;
        if (skipDepth === 0) continue;
        continue;
      }
      const typeMatch = line.match(/^export (interface|type) (\w+)/);
      if (typeMatch) {
        const typeName = typeMatch[2]!;
        if (seenTypes.has(typeName)) {
          skipDepth = 1;
          continue;
        }
        seenTypes.add(typeName);
      }
      allLines.push(line);
    }
  }
  fs.writeFileSync(filePath, allLines.join('\n') + '\n', 'utf-8');
  console.log(`代码已生成: ${filePath}`);
}

// ============================================================
// 按 Tag 生成
// ============================================================

/** 按 tag 生成所有接口的 fetch/curl 代码 */
function handleGenerateByTag(
  instance: ParsedInstance, tagName: string,
  options: { format: 'curl' | 'fetch' | 'axios'; baseUrl: string; types: boolean; comments: boolean; outDir: string | null },
) {
  const tag = instance.tags.find((t) => t.name === tagName || t.name.toLowerCase() === tagName.toLowerCase());
  if (!tag) {
    console.error(`未找到标签: ${tagName}`);
    console.error(`可用标签:`);
    instance.tags.forEach((t) => console.error(`  ${t.name} (${t.childrens.length} 个接口)`));
    process.exitCode = 1;
    return;
  }

  const apis = tag.childrens;
  if (apis.length === 0) {
    console.error(`标签 "${tagName}" 下没有接口`);
    process.exitCode = 1;
    return;
  }

  console.log(`标签 "${tagName}": ${apis.length} 个接口\n`);

  if (options.outDir) {
    // 所有接口代码写入同一个文件，重复的类型定义自动去重
    const outDirPath = path.resolve(options.outDir);
    fs.mkdirSync(outDirPath, { recursive: true });
    const fileName = `${tagName}.ts`;
    const filePath = path.join(outDirPath, fileName);

    const seenTypes = new Set<string>();
    const allLines: string[] = [];
    let skipDepth = 0;
    for (const api of apis) {
      const code = generateSingleApiCode(api, instance, options);
      for (const line of code.split('\n')) {
        if (skipDepth > 0) {
          if (/[{]/.test(line)) skipDepth++;
          if (/[}]/.test(line)) skipDepth--;
          if (skipDepth === 0) continue;
          continue;
        }
        const typeMatch = line.match(/^export (interface|type) (\w+)/);
        if (typeMatch) {
          const typeName = typeMatch[2]!;
          if (seenTypes.has(typeName)) {
            skipDepth = 1;
            continue;
          }
          seenTypes.add(typeName);
        }
        allLines.push(line);
      }
    }
    fs.writeFileSync(filePath, allLines.join('\n') + '\n', 'utf-8');
    console.log(`代码已生成: ${filePath}`);
  } else {
    for (const api of apis) {
      const code = generateSingleApiCode(api, instance, options);
      console.log(code);
      console.log('\n' + '='.repeat(72) + '\n');
    }
  }
}

/** 为单个接口生成代码（含头部注释） */
function generateSingleApiCode(
  api: ParsedApiInfo, instance: ParsedInstance,
  options: { format: 'curl' | 'fetch' | 'axios'; baseUrl: string; types: boolean; comments: boolean },
): string {
  const header = `// [${api.methodType}] ${api.url} - ${api.summary}`;
  let body: string;
  switch (options.format) {
    case 'curl':
      body = generateCurlCode(api, { baseUrl: options.baseUrl });
      break;
    case 'axios':
      body = generateAxiosCode(api, instance, {
        baseUrl: options.baseUrl, types: options.types, comments: options.comments,
      });
      break;
    default:
      body = generateFetchCode(api, instance, {
        baseUrl: options.baseUrl, types: options.types, comments: options.comments,
      });
  }
  return `${header}\n\n${body}\n`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
