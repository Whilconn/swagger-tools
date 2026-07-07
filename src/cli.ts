#!/usr/bin/env node
/**
 * CLI 入口
 *
 * 用法:
 *   swagger-tools <swagger.json>                              解析并输出摘要
 *   swagger-tools <swagger.json> output.json                  解析并输出 JSON
 *   swagger-tools generate <swagger.json> <path> [--curl]     生成 fetch 请求代码
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSwaggerSpec } from './parser.ts';
import { generateFetchCode, generateCurlCode } from './generator.ts';
import type { SwaggerSpec, ParsedInstance, ParsedApiInfo } from './types.ts';

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  // 判断子命令
  if (args[0] === 'generate' || args[0] === 'gen') {
    handleGenerate(args.slice(1));
  } else if (args[0] === '--help' || args[0] === '-h') {
    printHelp();
  } else {
    handleParse(args);
  }
}

function printHelp() {
  console.log(`swagger-tools - Swagger/OpenAPI 解析与代码生成工具

用法:
  swagger-tools <swagger.json> [output.json]           解析并输出摘要/JSON
  swagger-tools generate <swagger.json> <path> [opts]  生成 fetch 请求代码
  swagger-tools generate <swagger.json> --tag <tag>    按标签生成分组下所有接口代码

选项:
  --curl          生成 curl 命令而非 fetch
  --no-types      不生成 TypeScript 类型定义
  --no-comments   不生成注释
  --base-url <u>  设置基础 URL
  --tag <tag>     按标签 (tag) 生成该分组下所有接口的代码
  --out <path>    输出路径 (按标签生成时视为目录)

示例:
  swagger-tools api.json
  swagger-tools api.json parsed.json
  swagger-tools generate api.json /drawing/class/queryStudentRead
  swagger-tools generate api.json /drawing/class/queryStudentRead --curl
  swagger-tools generate api.json /drawing/class/queryStudentRead --base-url https://api.example.com
  swagger-tools generate api.json --tag 绘本相关
  swagger-tools generate api.json --tag 绘本相关 --out ./output --base-url https://api.example.com
`);
}

function loadSpec(filePath: string): SwaggerSpec {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`文件不存在: ${resolved}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  return JSON.parse(raw);
}

function handleParse(args: string[]) {
  const spec = loadSpec(args[0]!);
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

function handleGenerate(args: string[]) {
  if (args.length < 1) {
    console.error('用法: swagger-tools generate <swagger.json> [path] [opts]');
    console.error('  或: swagger-tools generate <swagger.json> --tag <tagName> [opts]');
    process.exit(1);
  }

  const spec = loadSpec(args[0]!);
  const instance = parseSwaggerSpec(spec);

  // 解析选项
  let useCurl = false;
  let baseUrl = '';
  let genTypes = true;
  let genComments = true;
  let outFile: string | null = null;
  let tagName: string | null = null;
  let pathArg: string | null = null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--curl') useCurl = true;
    else if (arg === '--no-types') genTypes = false;
    else if (arg === '--no-comments') genComments = false;
    else if (arg === '--base-url' && args[i + 1]) {
      baseUrl = args[++i]!;
    } else if (arg === '--out' && args[i + 1]) {
      outFile = args[++i]!;
    } else if (arg === '--tag' && args[i + 1]) {
      tagName = args[++i]!;
    } else if (!arg.startsWith('--')) {
      pathArg = arg;
    }
  }

  // 按 tag 生成
  if (tagName) {
    return handleGenerateByTag(instance, tagName, {
      useCurl,
      baseUrl,
      types: genTypes,
      comments: genComments,
      outDir: outFile,
    });
  }

  // 没有 path 参数报错
  if (!pathArg) {
    console.error('请指定接口路径或使用 --tag 指定标签');
    process.exit(1);
  }

  // 查找匹配的接口 (支持部分匹配)
  let api = instance.paths.find((p) => p.url === pathArg);
  if (!api) {
    api = instance.paths.find((p) => p.url.includes(pathArg));
  }
  if (!api) {
    console.error(`未找到路径: ${pathArg}`);
    console.error(`可用路径 (前10条):`);
    instance.paths.slice(0, 10).forEach((p) => console.error(`  [${p.methodType}] ${p.url}`));
    process.exit(1);
  }

  let code: string;
  if (useCurl) {
    code = `// [${api.methodType}] ${api.url} - ${api.summary}\n\n` + generateCurlCode(api, { baseUrl });
  } else {
    code =
      `// [${api.methodType}] ${api.url} - ${api.summary}\n\n` +
      generateFetchCode(api, instance, { baseUrl, types: genTypes, comments: genComments });
  }

  if (outFile) {
    const outPath = path.resolve(outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, code + '\n', 'utf-8');
    console.log(`代码已生成: ${outPath}`);
  } else {
    console.log(code);
  }
}

/** 按 tag 生成所有接口的 fetch/curl 代码 */
function handleGenerateByTag(
  instance: ParsedInstance,
  tagName: string,
  options: { useCurl: boolean; baseUrl: string; types: boolean; comments: boolean; outDir: string | null },
) {
  const tag = instance.tags.find((t) => t.name === tagName || t.name.toLowerCase() === tagName.toLowerCase());
  if (!tag) {
    console.error(`未找到标签: ${tagName}`);
    console.error(`可用标签:`);
    instance.tags.forEach((t) => console.error(`  ${t.name} (${t.childrens.length} 个接口)`));
    process.exit(1);
  }

  const apis = tag.childrens;
  if (apis.length === 0) {
    console.error(`标签 "${tagName}" 下没有接口`);
    process.exit(1);
  }

  console.log(`标签 "${tagName}": ${apis.length} 个接口\n`);

  if (options.outDir) {
    // 输出到目录，每个接口一个文件
    const outDirPath = path.resolve(options.outDir, tagName);
    fs.mkdirSync(outDirPath, { recursive: true });

    for (const api of apis) {
      const code = generateSingleApiCode(api, instance, options);
      const method = api.methodType.toLowerCase();
      const safePath = api.url
        .replace(/[\/{}]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      const fileName = `${method}_${safePath}.ts`;
      const filePath = path.join(outDirPath, fileName);
      fs.writeFileSync(filePath, code, 'utf-8');
      console.log(`  ✓ ${fileName}`);
    }
    console.log(`\n代码已生成到目录: ${outDirPath}`);
  } else {
    // 全部输出到 stdout
    for (const api of apis) {
      const code = generateSingleApiCode(api, instance, options);
      console.log(code);
      console.log('\n' + '='.repeat(72) + '\n');
    }
  }
}

/** 为单个接口生成代码（含头部注释） */
function generateSingleApiCode(
  api: ParsedApiInfo,
  instance: ParsedInstance,
  options: { useCurl: boolean; baseUrl: string; types: boolean; comments: boolean },
): string {
  const header = `// [${api.methodType}] ${api.url} - ${api.summary}`;
  let body: string;
  if (options.useCurl) {
    body = generateCurlCode(api, { baseUrl: options.baseUrl });
  } else {
    body = generateFetchCode(api, instance, {
      baseUrl: options.baseUrl,
      types: options.types,
      comments: options.comments,
    });
  }
  return `${header}\n\n${body}\n`;
}

main();
