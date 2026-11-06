#!/usr/bin/env bun
/**
 * Swagger/OpenAPI (2.0 / 3.0) → 前端请求代码（fetch / axios / cURL）+ TypeScript 类型
 *
 * 零依赖 TypeScript，直接用 Bun 运行（也可用 Node 22+ 的类型剥离能力）。
 * pinyin-pro 若可解析则用于中文模型名转写，否则保留中文标识符。
 *
 * 用法:
 *   bun gen.ts --file api.json --tags user-controller --out ./src/api --base-url https://x.com
 *   bun gen.ts --url https://x.com/v2/api-docs --paths /api/user/list --format axios
 *   bun gen.ts --file api.json --list
 *   bun gen.ts --file api.json --paths /api/user --out ./src/api/user.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ============================================================
// 类型定义（仅覆盖本脚本用到的规范字段）
// ============================================================

export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options' | 'trace';
export type OutputFormat = 'fetch' | 'axios' | 'curl';
export type ParamLocation = 'query' | 'path' | 'header' | 'body' | 'formData' | 'cookie';

/** JSON Schema 子集 + 扩展字段 */
export interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  nullable?: boolean;
  deprecated?: boolean;
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface MediaType {
  schema?: SchemaObject;
  example?: unknown;
}

export interface ResponseObject {
  description?: string;
  schema?: SchemaObject;
  content?: Record<string, MediaType>;
}

export interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: SchemaObject;
  items?: SchemaObject;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  $ref?: string;
  'x-example'?: unknown;
  [key: string]: unknown;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, MediaType>;
}

export interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  consumes?: string[];
  produces?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
}

export type PathItem = Partial<Record<HttpMethod, OperationObject>>;

export interface SpecInfo {
  title?: string;
  version?: string;
  description?: string;
}

export interface Spec {
  swagger?: string;
  openapi?: string;
  info?: SpecInfo;
  host?: string;
  basePath?: string;
  schemes?: string[];
  produces?: string[];
  servers?: { url?: string }[];
  paths?: Record<string, PathItem>;
  definitions?: Record<string, SchemaObject>;
  parameters?: Record<string, ParameterObject>;
  securityDefinitions?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    securitySchemes?: Record<string, unknown>;
  };
}

interface Options {
  file: string;
  url: string;
  tags: string[];
  paths: string[];
  search: string;
  out: string;
  baseUrl: string;
  format: string;
  types: boolean;
  comments: boolean;
  list: boolean;
  summary: boolean;
  json: boolean;
  rename: string;
  noBaseUrl: boolean;
  help: boolean;
}

interface Context {
  spec: Spec;
  oas2: boolean;
  opts: Options;
  definitions: Record<string, SchemaObject>;
  rename: Record<string, string>;
  /** 英文类型名 → 生成的代码 */
  types: Map<string, string>;
  /** 原始名 → 英文类型名 */
  usedNames: Map<string, string>;
  /** 来自映射表的名字，允许同义复用 */
  authoritative: Set<string>;
}

interface GenericType {
  base: string;
  args: string[];
  raw: string;
}

interface ParamInfo {
  name: string;
  in: ParamLocation;
  required: boolean;
  description: string;
  deprecated: boolean;
  schema: SchemaObject;
  example?: unknown;
  contentType?: string;
}

interface ResponseInfo {
  code: string;
  description: string;
  schema: SchemaObject | null;
}

interface ApiEntry {
  url: string;
  method: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  parameters: ParamInfo[];
  responses: ResponseInfo[];
  produces: string[];
}

interface ArgEntry {
  code: string;
  required: boolean;
}

interface RenderedApi {
  header: string;
  code: string;
}

// ============================================================
// 常量
// ============================================================

const BT = '`';
const METHODS: HttpMethod[] = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
const FORMATS: OutputFormat[] = ['fetch', 'axios', 'curl'];

// ============================================================
// 参数解析
// ============================================================

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    file: '',
    url: '',
    tags: [],
    paths: [],
    search: '',
    out: '',
    baseUrl: '',
    format: 'fetch',
    types: true,
    comments: true,
    list: false,
    summary: false,
    json: false,
    rename: '',
    noBaseUrl: false,
    help: false,
  };
  const split = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => argv[++i] ?? '';
    switch (arg) {
      case '--file': case '-f': opts.file = next(); break;
      case '--url': case '-u': opts.url = next(); break;
      case '--tags': case '-t': opts.tags.push(...split(next())); break;
      case '--paths': case '-p': opts.paths.push(...split(next())); break;
      case '--search': case '-s': opts.search = next(); break;
      case '--out': case '-o': opts.out = next(); break;
      case '--base-url': case '-b': opts.baseUrl = next(); break;
      case '--format': opts.format = next(); break;
      case '--rename': opts.rename = next(); break;
      case '--no-types': opts.types = false; break;
      case '--no-comments': opts.comments = false; break;
      case '--no-base-url': opts.noBaseUrl = true; break;
      case '--list': opts.list = true; break;
      case '--summary': opts.summary = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (!arg.startsWith('-') && !opts.file && !opts.url) opts.file = arg;
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`swagger-request-codegen — Swagger/OpenAPI JSON → 前端请求代码

用法:
  bun gen.ts --file <api.json> [选项]
  bun gen.ts --url  <spec-url> [选项]

输入（二选一）:
  -f, --file <path>      本地规范文件（JSON）
  -u, --url  <url>       远程规范地址

筛选（可组合，全部省略时输出全部接口）:
  -t, --tags   <a,b>     按 tag 名筛选（大小写不敏感）
  -p, --paths  <a,b>     按路径筛选（先精确后部分匹配）
  -s, --search <kw>      在 url / operationId / summary 中模糊搜索

输出:
  -o, --out <path>       输出目录（按 tag 分文件）或单个 .ts/.sh 文件；省略则打印到终端
  -b, --base-url <url>   请求基础地址（默认取 spec 的 host/basePath 或 servers[0]）
      --no-base-url      生成相对路径，交由请求实例的 baseURL 拼接
      --format <fmt>     fetch | axios | curl（默认 fetch）
      --no-types         不生成 TypeScript 类型
      --no-comments      不生成注释
      --rename <file>    类型重命名映射 JSON，如 {"学生成绩Vo":"StudentScoreVo"}
      --list             仅列出 tag / 接口清单（配合 --json 输出机器可读结果）
      --summary          仅输出规范摘要
      --json             与 --list / --summary 搭配，输出 JSON
  -h, --help             显示帮助`);
}

// ============================================================
// 规范加载
// ============================================================

async function loadSpec(opts: Options): Promise<Spec> {
  if (opts.url) {
    const res = await fetch(opts.url);
    if (!res.ok) throw new Error(`下载规范失败: ${opts.url} (HTTP ${res.status})`);
    const text = await res.text();
    try {
      return JSON.parse(text) as Spec;
    } catch {
      throw new Error('远程返回的内容不是 JSON（YAML 需先转换为 JSON）');
    }
  }
  const resolved = path.resolve(opts.file);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Spec;
}

// ============================================================
// 通用工具
// ============================================================

function isOas2(spec: Spec): boolean {
  return !String(spec.swagger || spec.openapi || '').startsWith('3');
}

function getClassName(ref: string | undefined, oas2: boolean): string | null {
  if (!ref) return null;
  const pattern = oas2 ? /^#\/definitions\/(.+)$/ : /^#\/components\/schemas\/(.+)$/;
  const match = ref.match(pattern);
  if (match) return match[1]!;
  if (!ref.includes('#') && !ref.includes('/')) return ref;
  return null;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function toCamelCase(str: string): string {
  const name = String(str).replace(/Using(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)$/i, '');
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function toSafeParamName(name: string): string {
  let out = String(name).replace(/[-\s](\w)/g, (_: string, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^\d/.test(out)) out = 'p' + out;
  return out;
}

/** 根据 method + path 生成函数名（无 operationId 时兜底） */
function deriveFunctionName(method: string, url: string): string {
  const parts = url.split('/').filter(Boolean).map((s) => s.replace(/[{}]/g, ''));
  const tail = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return toCamelCase(method.toLowerCase() + tail);
}

/** 必填参数排在可选参数之前，避免 TS1016 */
function orderArgs(entries: ArgEntry[]): string[] {
  return [
    ...entries.filter((e) => e.required),
    ...entries.filter((e) => !e.required),
  ].map((e) => e.code);
}

// ============================================================
// 类型名转换
// ============================================================

/** 常见中文包装类 → 英文 */
const WRAPPER_MAP: Record<string, string> = {
  '接口统一返回封装对象': 'ApiResponse',
  '统一返回封装对象': 'ApiResponse',
  '接口返回封装对象': 'ApiResponse',
  '分页返回封装对象': 'PageResponse',
  '分页返回封装': 'PageResponse',
  '分页封装对象': 'PageResponse',
  '分页封装': 'PageResponse',
  '通用返回封装对象': 'CommonResponse',
  '通用返回封装': 'CommonResponse',
  '返回结果封装对象': 'ResultResponse',
  '返回结果': 'Result',
  '列表返回封装': 'ListResponse',
  '树形返回封装': 'TreeResponse',
};

const PRIMITIVE_MAP: Record<string, string> = {
  int: 'number', integer: 'number', long: 'number', short: 'number', byte: 'number',
  double: 'number', float: 'number', number: 'number', bigdecimal: 'number',
  boolean: 'boolean', bool: 'boolean',
  string: 'string', char: 'string', character: 'string',
  object: 'Record<string, unknown>',
  date: 'string', datetime: 'string', 'date-time': 'string',
  void: 'void', null: 'null', file: 'File', multipartfile: 'File',
};

type PinyinFn = (text: string, options: { toneType: 'none'; type: 'array' }) => string[];

/**
 * 可选依赖：pinyin-pro（用于把纯中文模型名转成英文标识符）
 * 依次尝试从「当前工作目录」和「脚本所在目录」解析，保证 bun / node 行为一致。
 */
const pinyinFn: PinyinFn | null = (() => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  for (const base of [process.cwd(), scriptDir]) {
    try {
      const require = createRequire(path.join(base, 'package.json'));
      const mod = require('pinyin-pro') as { pinyin: PinyinFn };
      if (mod?.pinyin) return mod.pinyin;
    } catch {
      // 尝试下一个基准目录
    }
  }
  return null;
})();

function chineseToIdentifier(name: string): string {
  if (!pinyinFn) return name;
  const syllables = pinyinFn(name, { toneType: 'none', type: 'array' });
  return syllables.map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '')).join('');
}

/** 拆分 `Wrap«A«B»»` 形式的泛型 */
function splitGeneric(raw: string): GenericType {
  const text = String(raw).trim();
  const start = text.indexOf('«');
  if (start === -1) return { base: text, args: [], raw: text };

  const base = text.slice(0, start).trim();
  const inner = text.slice(start + 1, text.lastIndexOf('»')).trim();
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '«') depth++;
    if (ch === '»') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return { base, args, raw: text };
}

// ============================================================
// 生成上下文
// ============================================================

function createContext(spec: Spec, opts: Options): Context {
  const oas2 = isOas2(spec);
  const rename = opts.rename && fs.existsSync(opts.rename)
    ? (JSON.parse(fs.readFileSync(opts.rename, 'utf-8')) as Record<string, string>)
    : {};

  const definitions = (oas2 ? spec.definitions : spec.components?.schemas) ?? {};

  return {
    spec,
    oas2,
    opts,
    definitions,
    rename,
    types: new Map<string, string>(),
    usedNames: new Map<string, string>(),
    authoritative: new Set<string>(),
  };
}

/** 原始类型名 → 英文类型名（带冲突去重） */
function englishName(ctx: Context, raw: string): string {
  const name = String(raw).trim();
  if (name === 'List' || name === 'list') return 'Array';
  const renamed = ctx.rename[name];
  if (renamed) return renamed;
  if (PRIMITIVE_MAP[name.toLowerCase()] && /^[a-zA-Z]+$/.test(name)) return mapPrimitive(name);

  const existing = ctx.usedNames.get(name);
  if (existing) return existing;

  let candidate: string;
  let authoritative = false;

  const wrapped = WRAPPER_MAP[name];
  if (wrapped) {
    candidate = wrapped;
    authoritative = true;
  } else {
    const hit = Object.entries(WRAPPER_MAP).find(([cn]) => name.includes(cn));
    if (hit) {
      candidate = hit[1]!;
      authoritative = true;
    } else if (name.includes('.')) {
      candidate = name.slice(name.lastIndexOf('.') + 1);
    } else if (/[\u4e00-\u9fff]/.test(name)) {
      candidate = chineseToIdentifier(name);
    } else {
      candidate = name;
    }
  }

  candidate = candidate.replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '');
  if (!candidate) candidate = 'Model';
  if (/^\d/.test(candidate)) candidate = 'T' + candidate;
  candidate = candidate.charAt(0).toUpperCase() + candidate.slice(1);

  // 名字冲突处理
  const owner = ctx.usedNames.get(candidate);
  if (owner && owner !== name && !authoritative) {
    const fullBase = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name)
      .replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '');
    let alternative = fullBase !== candidate && !ctx.usedNames.has(fullBase)
      ? fullBase.charAt(0).toUpperCase() + fullBase.slice(1)
      : '';
    if (!alternative) {
      let i = 2;
      while (ctx.usedNames.has(candidate + i)) i++;
      alternative = candidate + i;
    }
    candidate = alternative;
  }

  ctx.usedNames.set(name, candidate);
  if (authoritative) ctx.authoritative.add(candidate);
  return candidate;
}

function mapPrimitive(name: string): string {
  const key = String(name).trim().toLowerCase();
  const mapped = PRIMITIVE_MAP[key];
  if (mapped) return mapped;
  if (/^(integer|int|long|short|byte|double|float|number)\(.*\)$/.test(key)) return 'number';
  if (/^(string|char)\(.*\)$/.test(key)) return 'string';
  return name;
}

/** 查找定义对应的真实 key */
function findDefKey(ctx: Context, raw: string): string | null {
  if (ctx.definitions[raw]) return raw;
  const { base } = splitGeneric(raw);
  const keys = Object.keys(ctx.definitions);
  return keys.find((k) => splitGeneric(k).base === base) ?? null;
}

/** 保证某个定义生成到 ctx.types，返回其 TS 名 */
function ensureInterface(ctx: Context, raw: string, genericArgRaw?: string): string {
  const key = findDefKey(ctx, raw);
  const { base, args } = splitGeneric(raw);
  const isGeneric = args.length > 0 || (key ? splitGeneric(key).args.length > 0 : false);
  const enName = englishName(ctx, base);

  if (ctx.types.has(enName)) return enName;

  if (!key) {
    // 未找到定义（如裸模型名或无 properties 的 schema），降级为占位类型
    ctx.types.set(enName, `export type ${enName} = Record<string, unknown>;`);
    return enName;
  }

  const schema = ctx.definitions[key]!;
  const argRaw = genericArgRaw || splitGeneric(key).args[0] || 'T';
  // 先占位，避免循环引用无限递归
  ctx.types.set(enName, `export type ${enName} = Record<string, unknown>;`);
  const code = isGeneric
    ? buildGenericInterface(ctx, enName, schema, argRaw)
    : buildTypeDeclaration(ctx, enName, schema);
  ctx.types.set(enName, code);
  return enName;
}

/** allOf / properties 合并 */
function mergedProperties(
  ctx: Context,
  schema: SchemaObject | undefined,
  seen: Set<string> = new Set(),
): Map<string, SchemaObject> {
  const result = new Map<string, SchemaObject>();
  if (!schema || typeof schema !== 'object') return result;

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const resolved = resolveSchemaRef(ctx, part, seen);
      for (const [k, v] of mergedProperties(ctx, resolved, seen)) {
        result.set(k, v);
      }
    }
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    result.set(k, v);
  }
  return result;
}

function resolveSchemaRef(ctx: Context, schema: SchemaObject, seen: Set<string> = new Set()): SchemaObject {
  let current = schema;
  while (current?.$ref) {
    const name = getClassName(current.$ref, ctx.oas2);
    if (!name || seen.has(name)) return {};
    seen.add(name);
    const defKey = findDefKey(ctx, name);
    current = (defKey ? ctx.definitions[defKey] : undefined) ?? {};
  }
  return current ?? {};
}

function isRequiredIn(ctx: Context, schema: SchemaObject, propName: string): boolean {
  if (Array.isArray(schema.required) && schema.required.includes(propName)) return true;
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.some((part) => isRequiredIn(ctx, resolveSchemaRef(ctx, part), propName));
  }
  return false;
}

/** 生成普通 interface / type */
function buildTypeDeclaration(ctx: Context, enName: string, schema: SchemaObject): string {
  const props = mergedProperties(ctx, schema);

  if (props.size > 0) {
    const lines = [`export interface ${enName} {`];
    for (const [propName, propSchema] of props) {
      lines.push(...propertyLines(ctx, propName, propSchema, schema));
    }
    lines.push('}');
    return lines.join('\n');
  }

  if (Array.isArray(schema.enum)) {
    return `export type ${enName} = ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')};`;
  }
  if (schema.type === 'array') {
    return `export type ${enName} = ${typeOfSchema(ctx, schema, true)};`;
  }
  if (schema.type && schema.type !== 'object') {
    return `export type ${enName} = ${mapPrimitive(schema.type)};`;
  }
  return `export type ${enName} = Record<string, unknown>;`;
}

/** 数据载体字段名候选 */
const PAYLOAD_KEYS = ['data', 'result', 'list', 'records', 'rows', 'items', 'content', 'dataList', 'body'];

/** 生成泛型包装 interface，如 PageResponse<T> */
function buildGenericInterface(ctx: Context, enName: string, schema: SchemaObject, argRaw: string): string {
  const props = mergedProperties(ctx, schema);
  const indent = '  ';
  const lines = [`export interface ${enName}<T> {`];
  const argBase = splitGeneric(argRaw).base;

  let payloadKey: string | null = null;
  for (const [propName, propSchema] of props) {
    if (refNameOf(ctx, propSchema) === argBase) {
      payloadKey = propName;
      break;
    }
  }
  if (!payloadKey) {
    payloadKey = PAYLOAD_KEYS.find((k) => props.has(k)) ?? null;
  }

  for (const [propName, propSchema] of props) {
    const optional = isRequiredIn(ctx, schema, propName) ? '' : '?';
    let tsType: string;
    if (propName === payloadKey) {
      tsType = propSchema.type === 'array' ? 'T[]' : 'T';
    } else {
      tsType = typeOfSchema(ctx, propSchema);
    }
    const description = propSchema.description;
    if (ctx.opts.comments && description) lines.push(`${indent}/** ${cleanComment(description)} */`);
    lines.push(`${indent}${propName}${optional}: ${tsType};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function propertyLines(
  ctx: Context,
  propName: string,
  propSchema: SchemaObject,
  parentSchema: SchemaObject,
): string[] {
  const indent = '  ';
  const lines: string[] = [];
  const optional = isRequiredIn(ctx, parentSchema, propName) ? '' : '?';
  const tsType = typeOfSchema(ctx, propSchema);
  const description = propSchema.description
    || (Array.isArray(propSchema.enum) ? `可用值: ${propSchema.enum.join(',')}` : '');
  if (ctx.opts.comments && description) lines.push(`${indent}/** ${cleanComment(description)} */`);
  if (ctx.opts.comments && propSchema.deprecated) lines.push(`${indent}/** @deprecated */`);
  const safeName = /^[A-Za-z_$][\w$]*$/.test(propName) ? propName : JSON.stringify(propName);
  lines.push(`${indent}${safeName}${optional}: ${tsType};`);
  return lines;
}

function cleanComment(text: unknown): string {
  return String(text).replace(/\*\//g, '*\\/').replace(/\r?\n/g, ' ');
}

/** 取 schema 引用的模型名（不生成定义） */
function refNameOf(ctx: Context, schema: SchemaObject | undefined): string | null {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) return getClassName(schema.$ref, ctx.oas2);
  if (schema.type === 'array' && schema.items) return refNameOf(ctx, schema.items);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    return refNameOf(ctx, schema.additionalProperties);
  }
  return null;
}

/** schema → TS 类型表达式（同时登记引用的 interface） */
function typeOfSchema(ctx: Context, schema: SchemaObject | undefined, forceArray = false): string {
  if (!schema || typeof schema !== 'object') return forceArray ? 'unknown[]' : 'unknown';

  if (schema.$ref) {
    const tsType = typeOfRef(ctx, getClassName(schema.$ref, ctx.oas2));
    return forceArray ? parenthesize(tsType) + '[]' : tsType;
  }

  const composed = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(composed) && composed.length > 0) {
    const union = composed.map((s) => typeOfSchema(ctx, s)).join(' | ');
    return forceArray ? `(${union})[]` : union;
  }

  if (schema.type === 'array') {
    const inner = schema.items ? typeOfSchema(ctx, schema.items) : 'unknown';
    return parenthesize(inner) + '[]';
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }

  if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
    if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const value = typeOfSchema(ctx, schema.additionalProperties);
      return `Record<string, ${value}>`;
    }
    if (!schema.properties && schema.additionalProperties === true) return 'Record<string, unknown>';
    const props = schema.properties ?? {};
    const entries = Object.entries(props);
    if (entries.length === 0) return 'Record<string, unknown>';
    const required = Array.isArray(schema.required) ? schema.required : [];
    const body = entries.map(([k, v]) => {
      const safeName = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      return `${safeName}${required.includes(k) ? '' : '?'}: ${typeOfSchema(ctx, v)}`;
    });
    const literal = `{ ${body.join('; ')} }`;
    return forceArray ? parenthesize(literal) + '[]' : literal;
  }

  if (schema.type) {
    const base = mapPrimitive(schema.type);
    return forceArray ? parenthesize(base) + '[]' : base;
  }

  // 无 type 且无其他线索时保守返回 unknown
  return forceArray ? 'unknown[]' : 'unknown';
}

function parenthesize(tsType: string): string {
  return /[|&]|=>/.test(tsType) ? `(${tsType})` : tsType;
}

/** `分页封装对象«StudentVo»` → `PageResponse<StudentVo>` */
function typeOfRef(ctx: Context, rawRef: string | null): string {
  if (!rawRef) return 'unknown';
  const { base, args } = splitGeneric(rawRef);

  if (args.length === 0) {
    const primitive = mapPrimitive(base);
    if (primitive !== base) return primitive;
    return ensureInterface(ctx, base);
  }

  const argTypes = args.map((a) => {
    const inner = splitGeneric(a);
    if (inner.args.length === 0) {
      const primitive = mapPrimitive(a);
      if (primitive !== a) return primitive;
      return ensureInterface(ctx, a);
    }
    return typeOfRef(ctx, a);
  });

  if (base === 'List' || base === 'list' || base === 'Array' || base === 'Set') {
    if (argTypes.length === 1) return parenthesize(argTypes[0]!) + '[]';
    return `(${argTypes.join(' | ')})[]`;
  }

  if (base.toLowerCase() === 'map' && argTypes.length === 2) {
    return `Record<string, ${argTypes[1]}>`;
  }

  const enBase = ensureInterface(ctx, rawRef, args[0]);
  return `${enBase}<${argTypes.join(', ')}>`;
}

// ============================================================
// 接口解析（归一化 OAS2 / OAS3）
// ============================================================

function resolveServerBase(ctx: Context): string {
  const spec = ctx.spec;
  if (ctx.oas2) {
    const scheme = spec.schemes?.[0] || 'https';
    const host = spec.host || '';
    const basePath = spec.basePath || '';
    if (!host) return '';
    return `${scheme}://${host}${basePath === '/' ? '' : basePath}`;
  }
  const server = spec.servers?.[0];
  if (server?.url) return server.url.replace(/\/+$/, '');
  return '';
}

function normalizeParameters(ctx: Context, operation: OperationObject): ParamInfo[] {
  const params: ParamInfo[] = [];

  for (const raw of operation.parameters ?? []) {
    let param: ParameterObject = raw;
    if (param.$ref) {
      const match = param.$ref.match(/^#\/components\/parameters\/(.+)$/) || param.$ref.match(/^#\/parameters\/(.+)$/);
      const name = match ? match[1]! : null;
      const source = name ? (ctx.spec.components?.parameters?.[name] ?? ctx.spec.parameters?.[name]) : undefined;
      if (!source) continue;
      param = source;
    }
    const schema: SchemaObject = param.schema
      ?? (param.items
        ? { type: 'array', items: param.items }
        : { type: param.type || 'string', format: param.format, enum: param.enum });
    params.push({
      name: param.name ?? 'param',
      in: (param.in as ParamLocation | undefined) ?? 'query',
      required: !!param.required,
      description: param.description ?? '',
      deprecated: !!param.deprecated,
      schema,
      example: param['x-example'] !== undefined ? param['x-example'] : param.default,
    });
  }

  // OAS3 requestBody
  if (!ctx.oas2 && operation.requestBody) {
    const body = operation.requestBody;
    const contents = Object.entries(body.content ?? {});
    const picked = contents.find(([type]) => type.includes('json')) ?? contents[0];
    if (picked) {
      const [contentType, media] = picked;
      const isMultipart = contentType.includes('multipart/form-data');
      params.push({
        name: 'data',
        in: isMultipart ? 'formData' : 'body',
        required: !!body.required,
        description: body.description ?? '',
        deprecated: false,
        schema: media.schema ?? {},
        contentType: isMultipart ? '' : contentType,
        example: media.example,
      });
    }
  } else if (ctx.oas2) {
    const body = params.find((p) => p.in === 'body');
    if (body) body.contentType = operation.consumes?.[0] || 'application/json';
  }

  return params;
}

function normalizeResponses(operation: OperationObject): ResponseInfo[] {
  const out: ResponseInfo[] = [];
  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    let schema = response.schema ?? null;
    if (!schema && response.content) {
      const contents = Object.entries(response.content);
      const picked = contents.find(([type]) => type.includes('json')) ?? contents[0];
      schema = picked?.[1].schema ?? null;
    }
    out.push({ code, description: response.description ?? '', schema });
  }
  return out;
}

function pickSuccessResponse(responses: ResponseInfo[]): ResponseInfo | null {
  return responses.find((r) => r.code === '200')
    ?? responses.find((r) => /^2\d\d$/.test(r.code))
    ?? responses.find((r) => r.code === 'default')
    ?? null;
}

function collectApis(ctx: Context): ApiEntry[] {
  const apis: ApiEntry[] = [];
  const paths = ctx.spec.paths ?? {};

  for (const [url, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      apis.push({
        url,
        method: method.toUpperCase(),
        operationId: operation.operationId ?? '',
        summary: (operation.summary || operation.description || '').split('\n')[0]!.trim(),
        description: operation.description ?? '',
        tags: operation.tags && operation.tags.length ? operation.tags : ['default'],
        deprecated: !!operation.deprecated,
        parameters: normalizeParameters(ctx, operation),
        responses: normalizeResponses(operation),
        produces: operation.produces ?? ctx.spec.produces ?? [],
      });
    }
  }
  return apis;
}

// ============================================================
// 代码生成
// ============================================================

function signatureArgs(ctx: Context, api: ApiEntry, body: ParamInfo | undefined, formData: ParamInfo[]): string[] {
  const entries: ArgEntry[] = [];
  for (const p of api.parameters.filter((x) => x.in === 'path')) {
    entries.push({ code: `${toSafeParamName(p.name)}: ${typeOfSchema(ctx, p.schema)}`, required: true });
  }
  for (const p of api.parameters.filter((x) => x.in === 'query' || x.in === 'header')) {
    entries.push({
      code: `${toSafeParamName(p.name)}${p.required ? '' : '?'}: ${typeOfSchema(ctx, p.schema)}`,
      required: p.required,
    });
  }
  if (body) {
    const bodyType = ctx.opts.types ? typeOfSchema(ctx, body.schema) : 'Record<string, unknown>';
    entries.push({ code: `data${body.required ? '' : '?'}: ${bodyType}`, required: body.required });
  }
  if (formData.length > 0) entries.push({ code: 'data: FormData', required: true });
  return orderArgs(entries);
}

function resolveReturnType(ctx: Context, api: ApiEntry): string {
  const success = pickSuccessResponse(api.responses);
  const noContent = !success || (!success.schema && /^20[45]$/.test(success.code));
  if (ctx.opts.types && success?.schema) return typeOfSchema(ctx, success.schema);
  return noContent ? 'void' : 'unknown';
}

function buildFetchFunction(ctx: Context, api: ApiEntry): string {
  const indent = '  ';
  const i2 = '    ';
  const query = api.parameters.filter((p) => p.in === 'query');
  const pathParams = api.parameters.filter((p) => p.in === 'path');
  const headers = api.parameters.filter((p) => p.in === 'header');
  const body = api.parameters.find((p) => p.in === 'body');
  const formData = api.parameters.filter((p) => p.in === 'formData');

  const fnName = toCamelCase(api.operationId || deriveFunctionName(api.method, api.url));
  const base = ctx.opts.baseUrl ? trimSlash(ctx.opts.baseUrl) : '';
  const args = signatureArgs(ctx, api, body, formData);
  const returnType = resolveReturnType(ctx, api);

  const lines: string[] = [];
  if (ctx.opts.comments && (api.summary || api.deprecated)) {
    lines.push('/**');
    if (api.summary) lines.push(` * ${cleanComment(api.summary)}`);
    if (api.description && api.description !== api.summary) {
      for (const line of api.description.split('\n')) lines.push(` * ${cleanComment(line)}`);
    }
    for (const p of [...pathParams, ...query, ...headers]) {
      if (p.description) lines.push(` * @param ${toSafeParamName(p.name)} ${cleanComment(p.description)}`);
    }
    if (body?.description) lines.push(` * @param data ${cleanComment(body.description)}`);
    if (api.deprecated) lines.push(' * @deprecated');
    lines.push(' */');
  }

  lines.push(args.length > 0
    ? `export async function ${fnName}(\n${args.map((a) => indent + a).join(',\n')}\n): Promise<${returnType}> {`
    : `export async function ${fnName}(): Promise<${returnType}> {`);

  // query string
  if (query.length > 0) {
    lines.push(`${indent}const params = new URLSearchParams();`);
    for (const p of query) {
      const name = toSafeParamName(p.name);
      if (ctx.opts.comments && p.description) lines.push(`${indent}// ${cleanComment(p.description)}`);
      lines.push(`${indent}if (${name} != null) params.append('${p.name}', String(${name}));`);
    }
    lines.push(`${indent}const query = params.toString();`);
    lines.push('');
  }

  // URL
  const pathWithParams = replacePathParams(api.url, pathParams);
  let urlExpr = pathParams.length > 0
    ? BT + base + pathWithParams + BT
    : `'${base}${api.url}'`;
  if (query.length > 0) urlExpr += ` + (query ? '?' + query : '')`;
  lines.push(`${indent}const url = ${urlExpr};`);
  lines.push('');

  // fetch init
  const initLines = [`${i2}method: '${api.method}',`];
  const headerLines: string[] = [];
  if (body?.contentType) headerLines.push(`${i2}'Content-Type': '${body.contentType}',`);
  for (const p of headers) {
    const name = toSafeParamName(p.name);
    headerLines.push(`${i2}'${p.name}': ${p.required ? name : `${name} ?? ''`},`);
  }
  if (headerLines.length > 0) {
    initLines.push(`${i2}headers: {`, ...headerLines.map((l) => indent + l), `${i2}},`);
  }
  if (body) initLines.push(`${i2}body: JSON.stringify(data),`);
  if (formData.length > 0) initLines.push(`${i2}body: data,`);

  lines.push(`${indent}const response = await fetch(url, {`);
  lines.push(...initLines);
  lines.push(`${indent}});`);
  lines.push('');
  lines.push(`${indent}if (!response.ok) {`);
  lines.push(`${i2}throw new Error(\`HTTP \${response.status}: \${url}\`);`);
  lines.push(`${indent}}`);
  lines.push('');

  if (returnType === 'void' || returnType === 'undefined') {
    lines.push(`${indent}return;`);
  } else {
    lines.push(`${indent}return response.json();`);
  }
  lines.push('}');
  return lines.join('\n');
}

function buildAxiosFunction(ctx: Context, api: ApiEntry): string {
  const indent = '  ';
  const i2 = '    ';
  const i3 = '      ';
  const query = api.parameters.filter((p) => p.in === 'query');
  const pathParams = api.parameters.filter((p) => p.in === 'path');
  const headers = api.parameters.filter((p) => p.in === 'header');
  const body = api.parameters.find((p) => p.in === 'body');
  const formData = api.parameters.filter((p) => p.in === 'formData');

  const fnName = toCamelCase(api.operationId || deriveFunctionName(api.method, api.url));
  const base = ctx.opts.baseUrl ? trimSlash(ctx.opts.baseUrl) : '';
  const args = signatureArgs(ctx, api, body, formData);
  const returnType = resolveReturnType(ctx, api);

  const lines: string[] = [];
  if (ctx.opts.comments && (api.summary || api.deprecated)) {
    lines.push('/**');
    if (api.summary) lines.push(` * ${cleanComment(api.summary)}`);
    for (const p of [...pathParams, ...query, ...headers]) {
      if (p.description) lines.push(` * @param ${toSafeParamName(p.name)} ${cleanComment(p.description)}`);
    }
    if (api.deprecated) lines.push(' * @deprecated');
    lines.push(' */');
  }

  lines.push(args.length > 0
    ? `export async function ${fnName}(\n${args.map((a) => indent + a).join(',\n')}\n): Promise<${returnType}> {`
    : `export async function ${fnName}(): Promise<${returnType}> {`);

  const pathWithParams = replacePathParams(api.url, pathParams);
  const urlExpr = pathParams.length > 0
    ? BT + base + pathWithParams + BT
    : `'${base}${api.url}'`;

  const config = [`${i2}method: '${api.method}',`, `${i2}url: ${urlExpr},`];

  if (query.length > 0) {
    config.push(`${i2}params: {`);
    for (const p of query) {
      config.push(`${i3}${p.name}: ${toSafeParamName(p.name)},`);
    }
    config.push(`${i2}},`);
  }

  const headerLines: string[] = [];
  if (body?.contentType) headerLines.push(`${i2}'Content-Type': '${body.contentType}',`);
  for (const p of headers) {
    const name = toSafeParamName(p.name);
    headerLines.push(`${i2}'${p.name}': ${p.required ? name : `${name} ?? ''`},`);
  }
  if (headerLines.length > 0) {
    config.push(`${i2}headers: {`, ...headerLines.map((l) => indent + l), `${i2}},`);
  }
  if (body || formData.length > 0) config.push(`${i2}data,`);

  lines.push(`${indent}const response = await axios.request<${returnType}>({`);
  lines.push(...config);
  lines.push(`${indent}});`);
  lines.push('');
  if (returnType === 'void') {
    lines.push(`${indent}return;`);
  } else {
    lines.push(`${indent}return response.data;`);
  }
  lines.push('}');
  return lines.join('\n');
}

function buildCurl(ctx: Context, api: ApiEntry): string {
  const base = ctx.opts.baseUrl ? trimSlash(ctx.opts.baseUrl) : '';
  const pathParams = api.parameters.filter((p) => p.in === 'path');
  const query = api.parameters.filter((p) => p.in === 'query');
  const headers = api.parameters.filter((p) => p.in === 'header');
  const body = api.parameters.find((p) => p.in === 'body');

  const url = replacePathParams(api.url, pathParams, (name, p) => (
    p.example !== undefined ? encodeURIComponent(String(p.example)) : `<${name}>`
  ));

  const qs = query.map((p) => (
    p.example !== undefined
      ? `${p.name}=${encodeURIComponent(String(p.example))}`
      : `${p.name}=<${p.name}>`
  )).join('&');

  const parts = [`curl -X '${api.method}' \\`, `  '${base}${url}${qs ? '?' + qs : ''}' \\`];

  if (body?.contentType) parts.push(`  -H 'Content-Type: ${body.contentType}' \\`);
  if (api.produces[0]) parts.push(`  -H 'Accept: ${api.produces[0]}' \\`);
  for (const p of headers) {
    const value = p.example !== undefined ? p.example : `<${p.name}>`;
    parts.push(`  -H '${p.name}: ${value}' \\`);
  }
  if (body) {
    const sample = body.example !== undefined ? body.example : sampleFromSchema(ctx, body.schema);
    const json = JSON.stringify(sample === undefined ? {} : sample);
    parts.push(`  --data-raw '${json}' \\`);
  }

  parts[parts.length - 1] = parts[parts.length - 1]!.replace(/ \\$/, '');
  return parts.join('\n');
}

function replacePathParams(
  url: string,
  pathParams: ParamInfo[],
  transform?: (name: string, param: ParamInfo) => string,
): string {
  let out = url;
  for (const p of pathParams) {
    const placeholder = transform ? transform(p.name, p) : '${' + toSafeParamName(p.name) + '}';
    out = out.split('{' + p.name + '}').join(placeholder);
  }
  return out;
}

/** 由 schema 生成示例值（用于 curl） */
function sampleFromSchema(ctx: Context, schema: SchemaObject | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return undefined;
  if (schema.$ref) {
    const key = findDefKey(ctx, getClassName(schema.$ref, ctx.oas2) ?? '');
    return key ? sampleFromSchema(ctx, ctx.definitions[key], depth + 1) : {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === 'array') return [sampleFromSchema(ctx, schema.items, depth + 1) ?? ''];
  if (schema.type === 'object' || schema.properties) {
    const out: Record<string, unknown> = {};
    const required = Array.isArray(schema.required) ? schema.required : Object.keys(schema.properties ?? {});
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      if (!required.includes(k)) continue;
      out[k] = sampleFromSchema(ctx, v, depth + 1);
    }
    return out;
  }
  switch (schema.type) {
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    default: return '';
  }
}

// ============================================================
// 文件组装
// ============================================================

function renderApi(ctx: Context, api: ApiEntry): RenderedApi {
  let code: string;
  if (ctx.opts.format === 'curl') {
    code = buildCurl(ctx, api);
  } else if (ctx.opts.format === 'axios') {
    code = buildAxiosFunction(ctx, api);
  } else {
    code = buildFetchFunction(ctx, api);
  }
  return { header: `// [${api.method}] ${api.url}${api.summary ? ' - ' + api.summary : ''}`, code };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按标识符出现情况收集当前文件需要的全部类型（含间接引用） */
function collectTypeClosure(code: string, ctx: Context): Set<string> {
  const found = new Set<string>();
  const stack: string[] = [code];
  const names = [...ctx.types.keys()];

  while (stack.length > 0) {
    const text = stack.pop()!;
    for (const name of names) {
      if (found.has(name)) continue;
      const pattern = new RegExp(`(?<![\\w$\\u4e00-\\u9fff])${escapeRegExp(name)}(?![\\w$\\u4e00-\\u9fff])`);
      if (pattern.test(text)) {
        found.add(name);
        const dep = ctx.types.get(name);
        if (dep) stack.push(dep);
      }
    }
  }
  return found;
}

function assemble(ctx: Context, apis: ApiEntry[], title: string): string {
  const apiCodes: string[] = [];
  for (const api of apis) {
    const rendered = renderApi(ctx, api);
    apiCodes.push(`${rendered.header}\n\n${rendered.code}`);
  }

  if (ctx.opts.format === 'curl') {
    return `${apiCodes.join('\n\n' + '='.repeat(72) + '\n\n')}\n`;
  }

  const apiSection = apiCodes.join('\n\n');
  const needed = collectTypeClosure(apiSection, ctx);
  const blocks = [...ctx.types.entries()]
    .filter(([name]) => needed.has(name))
    .map(([, code]) => code);

  const head = [
    '/**',
    ` * ${title}`,
    ' * 由 swagger-request-codegen 根据 OpenAPI 规范生成，可按项目规范调整。',
    ' */',
  ].join('\n');

  const typeSection = blocks.length > 0 ? blocks.join('\n\n') + '\n\n' : '';
  return `${head}\n\n${typeSection}${apiSection}\n`;
}

// ============================================================
// 主流程
// ============================================================

function selectApis(ctx: Context, apis: ApiEntry[]): ApiEntry[] {
  const opts = ctx.opts;
  let selected = apis;

  if (opts.tags.length > 0) {
    const wanted = opts.tags.map((t) => t.toLowerCase());
    selected = selected.filter((api) => api.tags.some((t) => wanted.includes(t.toLowerCase())));
  }
  if (opts.paths.length > 0) {
    const matched: ApiEntry[] = [];
    for (const wanted of opts.paths) {
      const exact = apis.filter((api) => api.url === wanted);
      const partial = exact.length > 0 ? exact : apis.filter((api) => api.url.includes(wanted));
      for (const api of partial) if (!matched.includes(api)) matched.push(api);
    }
    selected = selected.filter((api) => matched.includes(api));
  }
  if (opts.search) {
    const kw = opts.search.toLowerCase();
    selected = selected.filter((api) =>
      api.url.toLowerCase().includes(kw)
      || api.operationId.toLowerCase().includes(kw)
      || api.summary.toLowerCase().includes(kw)
      || api.tags.some((t) => t.toLowerCase().includes(kw)));
  }
  return selected;
}

function groupByTag(apis: ApiEntry[]): Map<string, ApiEntry[]> {
  const byTag = new Map<string, ApiEntry[]>();
  for (const api of apis) {
    for (const tag of api.tags) {
      const list = byTag.get(tag);
      if (list) list.push(api);
      else byTag.set(tag, [api]);
    }
  }
  return byTag;
}

function printList(ctx: Context, apis: ApiEntry[]): void {
  const info = ctx.spec.info ?? {};
  const byTag = groupByTag(apis);

  if (ctx.opts.json) {
    console.log(JSON.stringify({
      title: info.title ?? '',
      version: info.version ?? '',
      oas: ctx.spec.swagger ? `2.0 (${ctx.spec.swagger})` : `3.x (${ctx.spec.openapi ?? ''})`,
      baseUrl: ctx.opts.baseUrl || resolveServerBase(ctx),
      total: apis.length,
      tags: [...byTag.entries()].map(([name, list]) => ({
        name,
        count: list.length,
        apis: list.map((api) => ({
          method: api.method,
          url: api.url,
          operationId: api.operationId,
          summary: api.summary,
        })),
      })),
    }, null, 2));
    return;
  }

  console.log(`标题: ${info.title || '(无)'}   版本: ${info.version || '-'}`);
  console.log(`规范: ${ctx.spec.swagger ? `OAS ${ctx.spec.swagger}` : `OAS ${ctx.spec.openapi || '-'}`}   接口总数: ${apis.length}`);
  console.log(`BaseURL: ${ctx.opts.baseUrl || resolveServerBase(ctx) || '(未声明)'}`);

  for (const [tag, list] of byTag) {
    console.log(`\n[${tag}] ${list.length} 个接口`);
    for (const api of list) {
      const summary = api.summary ? ` - ${api.summary}` : '';
      console.log(`  ${api.method.padEnd(7)} ${api.url}${summary}`);
    }
  }
}

function printSummary(ctx: Context, apis: ApiEntry[]): void {
  const info = ctx.spec.info ?? {};
  const security = ctx.oas2 ? ctx.spec.securityDefinitions : ctx.spec.components?.securitySchemes;
  console.log(JSON.stringify({
    title: info.title ?? '',
    version: info.version ?? '',
    description: (info.description ?? '').slice(0, 500),
    oas: ctx.spec.swagger ? '2.0' : '3.x',
    baseUrl: ctx.opts.baseUrl || resolveServerBase(ctx),
    definitions: Object.keys(ctx.definitions).length,
    tagCount: new Set(apis.flatMap((a) => a.tags)).size,
    apiCount: apis.length,
    security: Object.keys(security ?? {}),
  }, null, 2));
}

function writeOutput(ctx: Context, apis: ApiEntry[], sourceName: string): void {
  const opts = ctx.opts;
  const ext = opts.format === 'curl' ? 'sh' : 'ts';

  if (!opts.out) {
    console.log(assemble(ctx, apis, sourceName));
    return;
  }

  const outPath = path.resolve(opts.out);
  const isFile = /\.(ts|js|sh|txt)$/i.test(opts.out);

  if (isFile) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, assemble(ctx, apis, sourceName), 'utf-8');
    console.log(`已生成: ${outPath}`);
    return;
  }

  fs.mkdirSync(outPath, { recursive: true });
  if (opts.tags.length > 0) {
    for (const tag of opts.tags) {
      const wanted = tag.toLowerCase();
      const list = apis.filter((api) => api.tags.some((t) => t.toLowerCase() === wanted));
      if (list.length === 0) {
        console.error(`跳过: tag "${tag}" 下没有接口`);
        continue;
      }
      const file = path.join(outPath, `${tag.replace(/[/\\:]/g, '-')}.${ext}`);
      fs.writeFileSync(file, assemble(ctx, list, `${sourceName} - ${tag}`), 'utf-8');
      console.log(`已生成: ${file} (${list.length} 个接口)`);
    }
    return;
  }

  const file = path.join(outPath, `paths.${ext}`);
  fs.writeFileSync(file, assemble(ctx, apis, sourceName), 'utf-8');
  console.log(`已生成: ${file} (${apis.length} 个接口)`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.file && !opts.url) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (!FORMATS.includes(opts.format as OutputFormat)) {
    throw new Error(`不支持的 --format: ${opts.format}（可选 fetch / axios / curl）`);
  }

  const spec = await loadSpec(opts);
  const ctx = createContext(spec, opts);
  if (opts.noBaseUrl) opts.baseUrl = '';
  else if (!opts.baseUrl) opts.baseUrl = resolveServerBase(ctx);

  const apis = collectApis(ctx);
  if (apis.length === 0) throw new Error('规范中未找到任何接口（paths 为空）');

  if (opts.list) {
    printList(ctx, apis);
    return;
  }
  if (opts.summary) {
    printSummary(ctx, apis);
    return;
  }

  const selected = selectApis(ctx, apis);
  if (selected.length === 0) {
    console.error('未匹配到任何接口。可用 tag:');
    console.error([...new Set(apis.flatMap((a) => a.tags))].join(', '));
    process.exitCode = 1;
    return;
  }

  writeOutput(ctx, selected, opts.file || opts.url);
}

main().catch((err: unknown) => {
  console.error(`错误: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
