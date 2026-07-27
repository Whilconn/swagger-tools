/**
 * 根据 ParsedApiInfo 生成 fetch 请求代码
 */
import type { ParsedApiInfo, ParsedParameter, ParsedDefinition, ParsedProperty, ParsedInstance } from './types.ts';
import { pinyin } from 'pinyin-pro';

/** 代码生成选项 */
export interface GenerateOptions {
  /** 基础 URL，如 https://api.example.com */
  baseUrl?: string;
  /** 是否生成 TypeScript 类型定义 */
  types?: boolean;
  /** 是否生成注释 */
  comments?: boolean;
  /** 缩进空格数 */
  indentSize?: number;
}

const DEFAULT_OPTIONS: Required<GenerateOptions> = {
  baseUrl: '',
  types: true,
  comments: true,
  indentSize: 2,
};

// ============ 泛型类型解析 ============

/** 泛型类型节点 */
interface GenericTypeNode {
  /** 外层类型名 (已去除中文) */
  name: string;
  /** 泛型参数 (可能为空) */
  params: GenericTypeNode[];
  /** 原始名称 (含中文和 «») */
  raw: string;
}

/** 中文包装类名 → 英文映射 */
const CHINESE_TYPE_MAP: Record<string, string> = {
  '接口统一返回封装对象': 'ApiResponse',
  '接口统一返回封装对象«': 'ApiResponse',
  '分页返回封装对象': 'PageResponse',
  '分页返回封装': 'PageResponse',
  '分页封装对象': 'PageResponse',
  '分页封装': 'PageResponse',
  '通用返回封装对象': 'CommonResponse',
  '通用返回封装': 'CommonResponse',
  '返回结果封装对象': 'ResultResponse',
  '返回结果': 'Result',
};

/** 原始/Java 类型名 → TypeScript 基础类型（用于泛型参数位置，如 ApiResponse«int» → ApiResponse<number>） */
const PRIMITIVE_TYPE_MAP: Record<string, string> = {
  int: 'number', integer: 'number', long: 'number', short: 'number', byte: 'number',
  double: 'number', float: 'number', number: 'number',
  boolean: 'boolean', bool: 'boolean',
  string: 'string', char: 'string', character: 'string',
  object: 'Record<string, unknown>',
  date: 'string', datetime: 'string', 'date-time': 'string',
  void: 'void', null: 'null',
};

/** 将原始类型名映射为 TypeScript 类型（非原始名原样返回） */
function mapPrimitiveType(name: string): string {
  const key = name.trim().toLowerCase();
  return PRIMITIVE_TYPE_MAP[key] ?? name;
}

/** 将含中文的名称转为可读的 PascalCase 英文标识符（基于拼音） */
function chineseToIdentifier(name: string): string {
  const syllables = pinyin(name, { toneType: 'none', type: 'array' }) as string[];
  const pascal = syllables
    .map(s => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''))
    .join('');
  return pascal.replace(/[^a-zA-Z0-9]/g, '') || 'UnknownType';
}

/**
 * 将含中文/嵌套的类型名转为英文。
 * - authoritative=true 表示结果来自 CHINESE_TYPE_MAP（直接或部分匹配），属于「已知概念」，
 *   多个不同原始名映射到同一英文是预期行为（同义词），允许复用。
 * - authoritative=false 表示结果来自拼音/简化/纯 ASCII 清洗，需做冲突去重。
 */
function toEnglishTypeName(name: string): { en: string; authoritative: boolean } {
  // 直接命中映射
  if (CHINESE_TYPE_MAP[name]) return { en: CHINESE_TYPE_MAP[name]!, authoritative: true };

  // 嵌套模型 (带点，如 StudentSeriesReadDetailVo.StudentLevelReadVo)：简化为最后一段
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx !== -1) {
    const last = name.substring(dotIdx + 1);
    const cleaned = last.replace(/[^a-zA-Z0-9]/g, '');
    if (cleaned) return { en: cleaned, authoritative: false };
    // 最后一段为纯中文：用拼音
    return { en: chineseToIdentifier(last), authoritative: false };
  }

  // 包含中文时，尝试部分匹配（命中映射表即视为已知概念）
  if (/[\u4e00-\u9fff]/.test(name)) {
    for (const [cn, en] of Object.entries(CHINESE_TYPE_MAP)) {
      if (name.includes(cn)) return { en, authoritative: true };
    }
    // 用拼音生成可读英文名（兼容混合 ASCII，如 学生考试成绩Vo）
    return { en: chineseToIdentifier(name), authoritative: false };
  }

  // 纯 ASCII，先检查是否是带格式后缀的基本类型（如 integer(int32)、number(double)）
  // authoritative=true 避免与另一基本类型（如 integer）的 'number' 产生冲突去重。
  const basicMatch = name.match(/^([a-zA-Z]+)(?:\(.*\))?$/);
  if (basicMatch) {
    const baseType = basicMatch[1]!.toLowerCase();
    if (['integer', 'int', 'long', 'short', 'byte', 'double', 'float', 'number'].includes(baseType))
      return { en: 'number', authoritative: true };
    if (['boolean', 'bool'].includes(baseType))
      return { en: 'boolean', authoritative: true };
    if (['string', 'char', 'character'].includes(baseType))
      return { en: 'string', authoritative: true };
  }

  // 非基本类型：清理特殊字符（去掉点、下划线等非字母数字字符）
  return { en: name.replace(/[^a-zA-Z0-9]/g, '') || 'UnknownType', authoritative: false };
}

/** 解析泛型字符串 `A«B«C»»` 为 GenericTypeNode 树 */
function parseGenericType(raw: string): GenericTypeNode {
  raw = raw.trim();

  const guillemetStart = raw.indexOf('«');
  if (guillemetStart === -1) {
    // 无泛型参数
    return { name: toEnglishName(raw), params: [], raw };
  }

  const outerName = raw.substring(0, guillemetStart).trim();
  // 提取 «  » 之间的内容，处理嵌套
  const innerStr = raw.substring(guillemetStart + 1, raw.lastIndexOf('»')).trim();

  // 拆分多个泛型参数 (顶层逗号，不拆分嵌套 «» 内的逗号)
  const params = splitTopLevel(innerStr).map(p => parseGenericType(p));

  return {
    name: toEnglishName(outerName),
    params,
    raw,
  };
}

/** 在顶层按逗号拆分 (忽略 «» 内的逗号) */
function splitTopLevel(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '«') depth++;
    else if (ch === '»') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * 类型名缓存：原始名 -> 最终英文类型名
 * 保证同一原始名在整次生成中始终映射到同一类型名（与 cli 的「按名去重」配合），
 * 并在发生重名时回退为完整拼接名 + 数字后缀，避免类型冲突。
 */
const typeNameCache = new Map<string, string>();
const usedTypeNames = new Set<string>();

/** 外层类型名转英文（带冲突去重） */
function toEnglishName(name: string): string {
  // List 在 TS 中映射为 Array
  if (name === 'List' || name === 'list') return 'Array';
  if (typeNameCache.has(name)) return typeNameCache.get(name)!;

  const { en: candidate, authoritative } = toEnglishTypeName(name);
  if (!usedTypeNames.has(candidate)) {
    usedTypeNames.add(candidate);
    typeNameCache.set(name, candidate);
    return candidate;
  }

  // 重名处理
  if (authoritative) {
    // 来自映射表的同义词（如 分页封装对象 / 分页返回封装对象 都应是 PageResponse），
    // 复用同一英文名是预期行为，直接返回即可。
    typeNameCache.set(name, candidate);
    return candidate;
  }

  // 简化/清洗得到的重名：回退到完整拼接名（去除点等非字母数字字符；纯中文用拼音）
  const full = name.replace(/[^a-zA-Z0-9]/g, '') || chineseToIdentifier(name);
  if (full !== candidate && !usedTypeNames.has(full)) {
    usedTypeNames.add(full);
    typeNameCache.set(name, full);
    return full;
  }

  // 仍重名：追加数字后缀
  let i = 1;
  let alt = `${full}${i}`;
  while (usedTypeNames.has(alt)) {
    i++;
    alt = `${full}${i}`;
  }
  usedTypeNames.add(alt);
  typeNameCache.set(name, alt);
  return alt;
}

/** 将 GenericTypeNode 转为 TypeScript 类型字符串 */
function genericNodeToTsType(node: GenericTypeNode): string {
  if (node.params.length === 0) {
    return mapPrimitiveType(node.name);
  }

  // List<T> 或 Array<T> → T[]
  if (node.name === 'Array') {
    const inner = node.params.map(p => genericNodeToTsType(p)).join(' | ');
    // 多个泛型参数时用 union，单个用数组
    if (node.params.length === 1) {
      const innerType = genericNodeToTsType(node.params[0]!);
      return innerType.includes(' | ') ? `(${innerType})[]` : `${innerType}[]`;
    }
    return `(${inner})[]`;
  }

  // 其他泛型: Wrapper<T, U>
  const params = node.params.map(p => genericNodeToTsType(p)).join(', ');
  return `${node.name}<${params}>`;
}

// ============ 响应类型收集与生成 ============

/** 收集响应类型链中引用的所有 definition 名称 */
function collectResponseTypes(node: GenericTypeNode, definitions: ParsedDefinition[], collected: Set<string>): void {
  // 当前节点名是否对应一个 definition
  const def = definitions.find(d => d.name === node.raw || d.name === node.name);
  if (def && !collected.has(def.name)) {
    collected.add(def.name);
    // 递归收集属性中引用的类型
    for (const prop of def.properties) {
      if (prop.refType) {
        const innerDef = definitions.find(d => d.name === prop.refType);
        if (innerDef && !collected.has(innerDef.name)) {
          // 检查 refType 是否是泛型
          if (prop.refType.includes('«')) {
            const innerNode = parseGenericType(prop.refType!);
            collectResponseTypes(innerNode, definitions, collected);
          } else {
            collected.add(innerDef.name);
            collectDefinitionProperties(innerDef, definitions, collected);
          }
        }
      }
    }
  }
  // 递归处理泛型参数
  for (const param of node.params) {
    collectResponseTypes(param, definitions, collected);
  }
}

/** 递归收集 definition 属性中引用的类型 */
function collectDefinitionProperties(def: ParsedDefinition, definitions: ParsedDefinition[], collected: Set<string>): void {
  for (const prop of def.properties) {
    if (prop.refType && !prop.refType.includes('«')) {
      const innerDef = definitions.find(d => d.name === prop.refType);
      if (innerDef && !collected.has(innerDef.name)) {
        collected.add(innerDef.name);
        collectDefinitionProperties(innerDef, definitions, collected);
      }
    }
    if (prop.refType && prop.refType.includes('«')) {
      const innerNode = parseGenericType(prop.refType);
      collectResponseTypes(innerNode, definitions, collected);
    }
  }
}

/** 收集单个接口需要生成的所有类型：响应类型 + 请求 body 及其递归引用的嵌套类型 */
function collectAllApiTypes(
  api: ParsedApiInfo,
  responseNode: GenericTypeNode | null,
  definitions: ParsedDefinition[],
  collected: Set<string>,
): void {
  // 响应侧
  if (responseNode) {
    collectResponseTypes(responseNode, definitions, collected);
  }
  // 请求 body 侧（含其递归引用的嵌套 $ref 类型）
  const bodyParams = api.parameters.filter(p => p.in === 'body');
  if (bodyParams.length > 0 && bodyParams[0]!.def) {
    const def = bodyParams[0]!.def!;
    if (!collected.has(def.name)) {
      collected.add(def.name);
      collectDefinitionProperties(def, definitions, collected);
    }
  }
}

/** 由已收集的 definition 名称集合生成所有 interface 定义 */
function generateTypeInterfaces(
  collected: Set<string>,
  definitions: ParsedDefinition[],
  opts: Required<GenerateOptions>,
): string[] {
  const interfaces: string[] = [];
  const generated = new Set<string>();

  for (const defName of collected) {
    const def = definitions.find(d => d.name === defName);
    if (!def) continue;

    // 判断是否是泛型包装类 (名称含 « 或属性 data 的 refType 含 «)
    const isGenericWrapper = defName.includes('«') ||
      def.properties.some(p => p.refType?.includes('«'));

    if (isGenericWrapper) {
      // 生成泛型 interface，如 ApiResponse<T>
      const baseName = def.name.replace(/«.*»$/, '');
      const enName = toEnglishName(baseName);
      if (!generated.has(enName)) {
        interfaces.push(generateGenericInterface(enName, def, opts));
        generated.add(enName);
      }
    } else {
      const enName = toEnglishName(def.name);
      if (!generated.has(enName)) {
        interfaces.push(generateInterface(enName, def.properties, opts));
        generated.add(enName);
      }
    }
  }

  return interfaces;
}

/** 生成响应相关的所有 interface 定义 */
function generateResponseTypes(
  responseNode: GenericTypeNode,
  definitions: ParsedDefinition[],
  opts: Required<GenerateOptions>,
): string[] {
  const collected = new Set<string>();
  collectResponseTypes(responseNode, definitions, collected);
  return generateTypeInterfaces(collected, definitions, opts);
}

/** 生成泛型 interface (如 ApiResponse<T>) */
function generateGenericInterface(
  enName: string,
  def: ParsedDefinition,
  opts: Required<GenerateOptions>,
): string {
  const indent = ' '.repeat(opts.indentSize);
  const lines: string[] = [];

  // 泛型参数名
  const typeParam = 'T';
  lines.push(`export interface ${enName}<${typeParam}> {`);

  // 从 定义名 (如 `分页封装对象«StudentReadRecordVo»`) 中取出泛型实参原始名，
  // 用于定位真正的「数据载体」字段（可能是 data / result / list 等），将其类型设为 T。
  const baseName = def.name.replace(/«.*»$/, '');
  const innerRaw = def.name.slice(baseName.length).replace(/^«/, '').replace(/»$/, '');

  const payloadCandidates = ['data', 'result', 'list', 'records', 'content', 'items', 'rows', 'dataList'];
  let payloadProp: ParsedProperty | undefined;
  if (innerRaw) {
    payloadProp = def.properties.find(p => p.refType && p.refType === innerRaw);
  }
  if (!payloadProp) {
    // 数据载体字段（data/result/list 等）即使其类型为原始类型（无 refType，如 integer），
    // 也应识别为泛型参数 T 的载体，而非写成具体原始类型，否则 <T> 形同虚设。
    payloadProp = def.properties.find(p => payloadCandidates.includes(p.name))
      ?? def.properties.find(p => !!p.refType);
  }

  for (const prop of def.properties) {
    const optional = prop.required ? '' : '?';
    let tsType: string;

    if (payloadProp && prop === payloadProp) {
      // 数据载体字段使用泛型参数 T（数组则 T[]）
      tsType = prop.type === 'array' ? `${typeParam}[]` : typeParam;
    } else {
      tsType = propertyToTsType(prop);
    }

    if (opts.comments && prop.description) {
      lines.push(`${indent}/** ${prop.description} */`);
    }
    lines.push(`${indent}${prop.name}${optional}: ${tsType};`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ============ 主生成函数 ============

/**
 * 根据 ParsedApiInfo 生成 fetch 请求代码
 * @param api 接口信息
 * @param instance 完整解析实例 (用于查找 definitions)
 * @param options 生成选项
 */
export function generateFetchCode(
  api: ParsedApiInfo,
  instance?: ParsedInstance,
  options?: GenerateOptions,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = ' '.repeat(opts.indentSize);
  const definitions = instance?.definitions || [];

  const lines: string[] = [];
  const functionName = toCamelCase(api.operationId || api.summary || api.id);

  // 收集请求参数
  const queryParams = api.parameters.filter(p => p.in === 'query');
  const pathParams = api.parameters.filter(p => p.in === 'path');
  const headerParams = api.parameters.filter(p => p.in === 'header');
  const bodyParams = api.parameters.filter(p => p.in === 'body');
  const formDataParams = api.parameters.filter(p => p.in === 'formData');

  // 构建 URL
  let urlPath = api.url;
  for (const pp of pathParams) {
    if (pp.name) {
      urlPath = urlPath.replace(`{${pp.name}}`, `\${${toSafeParamName(pp.name)}}`);
    }
  }
  const hasPathParams = pathParams.length > 0;
  const urlExpr = opts.baseUrl
    ? (hasPathParams ? `\`${opts.baseUrl}${urlPath}\`` : `'${opts.baseUrl}${api.url}'`)
    : (hasPathParams ? `\`${urlPath}\`` : `'${api.url}'`);

  // 函数参数
  const funcParams: string[] = [];
  for (const pp of pathParams) {
    funcParams.push(`${toSafeParamName(pp.name!)}: ${resolveTsType(pp)}`);
  }
  for (const qp of queryParams) {
    const optional = qp.require ? '' : '?';
    funcParams.push(`${toSafeParamName(qp.name!)}${optional}: ${resolveTsType(qp)}`);
  }
  for (const hp of headerParams) {
    const optional = hp.require ? '' : '?';
    funcParams.push(`${toSafeParamName(hp.name!)}${optional}: ${resolveTsType(hp)}`);
  }
  if (bodyParams.length > 0) {
    const bp = bodyParams[0]!;
    if (bp.def && opts.types) {
      const reqTypeName = toEnglishName(bp.def.name);
      funcParams.push(`data: ${reqTypeName}`);
    } else {
      funcParams.push(`data: ${resolveBodyTsType(bp)}`);
    }
  }
  if (formDataParams.length > 0) {
    funcParams.push(`data: FormData`);
  }

  const funcParamsStr = funcParams.length > 0 ? `\n${funcParams.map(p => `${indent}${p}`).join(',\n')}\n` : '';

  // 解析响应类型
  const response200 = api.responseCodes.find(r => r.code === '200');
  let returnTypeTs = 'unknown';
  let responseNode: GenericTypeNode | null = null;

  if (response200?.schema) {
    responseNode = parseGenericType(response200.schema);
    returnTypeTs = genericNodeToTsType(responseNode);
  } else if (response200?.responseText) {
    returnTypeTs = basicTypeToTs(response200.responseText);
  }

  // 生成 TypeScript 类型定义（请求 body 及其嵌套类型 + 响应类型，统一去重递归生成）
  if (opts.types) {
    const collected = new Set<string>();
    collectAllApiTypes(api, responseNode, definitions, collected);
    const typeInterfaces = generateTypeInterfaces(collected, definitions, opts);
    for (const iface of typeInterfaces) {
      lines.push(iface);
      lines.push('');
    }
  }

  // 函数注释
  if (opts.comments && api.summary) {
    lines.push('/**');
    lines.push(` * ${api.summary}`);
    if (api.deprecated) lines.push(' * @deprecated');
    lines.push(' */');
  }

  // 函数签名
  lines.push(`export async function ${functionName}(${funcParamsStr}): Promise<${returnTypeTs}> {`);

  // 函数体内缩进
  const i1 = indent;
  const i2 = indent + indent;
  const i3 = i2 + indent;

  const fetchInitLines: string[] = [];
  fetchInitLines.push(`${i2}method: '${api.methodType}',`);

  // Headers
  const headerLines: string[] = [];
  const contentType = api.consumes[0] || 'application/json';
  if (contentType && bodyParams.length > 0) {
    headerLines.push(`${i3}'Content-Type': '${contentType}',`);
  }
  if (contentType && formDataParams.length > 0) {
    headerLines.push(`${i3}// Content-Type 由浏览器自动设置 (multipart/form-data)`);
  }
  for (const hp of headerParams) {
    const val = hp.require
      ? `${toSafeParamName(hp.name!)}`
      : `${toSafeParamName(hp.name!)} ?? ''`;
    headerLines.push(`${i3}'${hp.name}': ${val},`);
  }
  if (headerLines.length > 0) {
    fetchInitLines.push(`${i2}headers: {`);
    fetchInitLines.push(...headerLines);
    fetchInitLines.push(`${i2}},`);
  }

  // Query string
  if (queryParams.length > 0) {
    lines.push(`${i1}const params = new URLSearchParams();`);
    for (const qp of queryParams) {
      const val = toSafeParamName(qp.name!);
      if (opts.comments && qp.description) {
        lines.push(`${i1}// ${qp.description}`);
      }
      lines.push(`${i1}if (${val} != null) params.append('${qp.name}', String(${val}));`);
    }
    lines.push('');
  }

  // Body
  if (bodyParams.length > 0) {
    fetchInitLines.push(`${i2}body: JSON.stringify(data),`);
  }
  if (formDataParams.length > 0) {
    fetchInitLines.push(`${i2}body: data,`);
  }

  // 构建 URL (含 query string)
  let finalUrlExpr = urlExpr;
  if (queryParams.length > 0) {
    finalUrlExpr = hasPathParams
      ? `\`${urlPath}\${params.toString() ? '?' + params.toString() : ''}\``
      : `'${api.url}' + (params.toString() ? '?' + params.toString() : '')`;
    if (opts.baseUrl) {
      finalUrlExpr = `'${opts.baseUrl}' + ${finalUrlExpr.startsWith('`') ? finalUrlExpr.slice(1, -1) : finalUrlExpr}`;
    }
  }

  // fetch 调用
  lines.push(`${i1}const response = await fetch(${finalUrlExpr}, {`);
  lines.push(...fetchInitLines);
  lines.push(`${i1}});`);
  lines.push('');
  lines.push(`${i1}if (!response.ok) {`);
  lines.push(`${i2}throw new Error(\`HTTP error! status: \${response.status}\`);`);
  lines.push(`${i1}}`);
  lines.push('');
  lines.push(`${i1}return response.json();`);
  lines.push('}');

  return lines.join('\n');
}

/**
 * 生成纯 curl 命令
 */
export function generateCurlCode(api: ParsedApiInfo, options?: GenerateOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const baseUrl = opts.baseUrl || '';

  const queryParams = api.parameters.filter(p => p.in === 'query');
  const pathParams = api.parameters.filter(p => p.in === 'path');
  const headerParams = api.parameters.filter(p => p.in === 'header');
  const bodyParams = api.parameters.filter(p => p.in === 'body');

  let urlPath = api.url;
  for (const pp of pathParams) {
    if (pp.name) urlPath = urlPath.replace(`{${pp.name}}`, `<${pp.name}>`);
  }

  let url = `${baseUrl}${urlPath}`;
  if (queryParams.length > 0) {
    const qs = queryParams.map(qp => {
      const val = qp.example ?? qp.value ?? `<${qp.name}>`;
      return `${qp.name}=${encodeURIComponent(String(val))}`;
    }).join('&');
    url += `?${qs}`;
  }

  const parts: string[] = [];
  parts.push(`curl -X '${api.methodType}' \\`);
  parts.push(`  '${url}' \\`);

  const contentType = api.consumes[0] || 'application/json';
  if (bodyParams.length > 0) {
    parts.push(`  -H 'Content-Type: ${contentType}' \\`);
  }
  parts.push(`  -H 'Accept: ${api.produces[0] || '*/*'}' \\`);
  for (const hp of headerParams) {
    const val = hp.example ?? `<${hp.name}>`;
    parts.push(`  -H '${hp.name}: ${val}' \\`);
  }

  if (bodyParams.length > 0) {
    const bp = bodyParams[0]!;
    const bodyVal = bp.txtValue || (bp.value ? JSON.stringify(bp.value) : '{}');
    const oneLine = bodyVal.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    parts.push(`  -d '${oneLine}' \\`);
  }

  const last = parts[parts.length - 1]!;
  parts[parts.length - 1] = last.replace(/ \\$/, '');

  return parts.join('\n');
}

/**
 * 生成 axios 请求代码
 */
export function generateAxiosCode(
  api: ParsedApiInfo,
  instance?: ParsedInstance,
  options?: GenerateOptions,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = ' '.repeat(opts.indentSize);
  const definitions = instance?.definitions || [];

  const lines: string[] = [];
  const functionName = toCamelCase(api.operationId || api.summary || api.id);

  // 收集请求参数
  const queryParams = api.parameters.filter(p => p.in === 'query');
  const pathParams = api.parameters.filter(p => p.in === 'path');
  const headerParams = api.parameters.filter(p => p.in === 'header');
  const bodyParams = api.parameters.filter(p => p.in === 'body');
  const formDataParams = api.parameters.filter(p => p.in === 'formData');

  // 构建 URL
  let urlPath = api.url;
  for (const pp of pathParams) {
    if (pp.name) {
      urlPath = urlPath.replace(`{${pp.name}}`, `\${${toSafeParamName(pp.name)}}`);
    }
  }
  const hasPathParams = pathParams.length > 0;
  const urlExpr = opts.baseUrl
    ? (hasPathParams ? `\`${opts.baseUrl}${urlPath}\`` : `'${opts.baseUrl}${api.url}'`)
    : (hasPathParams ? `\`${urlPath}\`` : `'${api.url}'`);

  // 函数参数
  const funcParams: string[] = [];
  for (const pp of pathParams) {
    funcParams.push(`${toSafeParamName(pp.name!)}: ${resolveTsType(pp)}`);
  }
  for (const qp of queryParams) {
    const optional = qp.require ? '' : '?';
    funcParams.push(`${toSafeParamName(qp.name!)}${optional}: ${resolveTsType(qp)}`);
  }
  for (const hp of headerParams) {
    const optional = hp.require ? '' : '?';
    funcParams.push(`${toSafeParamName(hp.name!)}${optional}: ${resolveTsType(hp)}`);
  }
  if (bodyParams.length > 0) {
    const bp = bodyParams[0]!;
    if (bp.def && opts.types) {
      const reqTypeName = toEnglishName(bp.def.name);
      funcParams.push(`data: ${reqTypeName}`);
    } else {
      funcParams.push(`data: ${resolveBodyTsType(bp)}`);
    }
  }
  if (formDataParams.length > 0) {
    funcParams.push(`data: FormData`);
  }

  const funcParamsStr = funcParams.length > 0 ? `\n${funcParams.map(p => `${indent}${p}`).join(',\n')}\n` : '';

  // 解析响应类型
  const response200 = api.responseCodes.find(r => r.code === '200');
  let returnTypeTs = 'unknown';
  let responseNode: GenericTypeNode | null = null;

  if (response200?.schema) {
    responseNode = parseGenericType(response200.schema);
    returnTypeTs = genericNodeToTsType(responseNode);
  } else if (response200?.responseText) {
    returnTypeTs = basicTypeToTs(response200.responseText);
  }

  // 生成 TypeScript 类型定义（请求 body 及其嵌套类型 + 响应类型，统一去重递归生成）
  if (opts.types) {
    const collected = new Set<string>();
    collectAllApiTypes(api, responseNode, definitions, collected);
    const typeInterfaces = generateTypeInterfaces(collected, definitions, opts);
    for (const iface of typeInterfaces) {
      lines.push(iface);
      lines.push('');
    }
  }

  // 函数注释
  if (opts.comments && api.summary) {
    lines.push('/**');
    lines.push(` * ${api.summary}`);
    if (api.deprecated) lines.push(' * @deprecated');
    lines.push(' */');
  }

  // 函数签名
  lines.push(`export async function ${functionName}(${funcParamsStr}): Promise<${returnTypeTs}> {`);

  // 函数体内缩进
  const i1 = indent;
  const i2 = indent + indent;
  const i3 = i2 + indent;

  // 构建 axios config
  const configLines: string[] = [];
  configLines.push(`${i2}method: '${api.methodType}',`);
  configLines.push(`${i2}url: ${urlExpr},`);

  // Query params
  if (queryParams.length > 0) {
    configLines.push(`${i2}params: {`);
    for (const qp of queryParams) {
      if (opts.comments && qp.description) {
        configLines.push(`${i3}// ${qp.description}`);
      }
      configLines.push(`${i3}${qp.name}: ${toSafeParamName(qp.name!)},`);
    }
    configLines.push(`${i2}},`);
  }

  // Headers
  const headerLines: string[] = [];
  const contentType = api.consumes[0] || 'application/json';
  if (contentType && bodyParams.length > 0) {
    headerLines.push(`${i3}'Content-Type': '${contentType}',`);
  }
  if (contentType && formDataParams.length > 0) {
    headerLines.push(`${i3}// Content-Type 由浏览器自动设置 (multipart/form-data)`);
  }
  for (const hp of headerParams) {
    const val = hp.require
      ? `${toSafeParamName(hp.name!)}`
      : `${toSafeParamName(hp.name!)} ?? ''`;
    headerLines.push(`${i3}'${hp.name}': ${val},`);
  }
  if (headerLines.length > 0) {
    configLines.push(`${i2}headers: {`);
    configLines.push(...headerLines);
    configLines.push(`${i2}},`);
  }

  // Body
  if (bodyParams.length > 0) {
    configLines.push(`${i2}data: data,`);
  }
  if (formDataParams.length > 0) {
    configLines.push(`${i2}data: data,`);
  }

  // Axios 调用
  lines.push(`${i1}const response = await axios(${configLines.length > 3 ? `{\n${configLines.join('\n')}\n${i1}}` : `{ ${configLines.join(' ')} }`});`);
  lines.push('');
  lines.push(`${i1}return response.data;`);
  lines.push('}');

  return lines.join('\n');
}

// ============ 辅助函数 ============

function toCamelCase(str: string): string {
  let name = str.replace(/Using(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i, '');
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function toSafeParamName(name: string): string {
  return name.replace(/[-\s](\w)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

function basicTypeToTs(type: string): string {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  return 'unknown';
}

function resolveTsType(param: ParsedParameter): string {
  const t = param.type;
  if (!t) return 'unknown';

  if (t === 'integer' || t.startsWith('integer(')) return 'number';
  if (t === 'number' || t.startsWith('number(')) return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string' || t.startsWith('string(')) return 'string';
  if (t === 'array') {
    if (param.schemaValue) {
      // schemaValue 可能含泛型
      if (param.schemaValue.includes('«')) {
        const node = parseGenericType(param.schemaValue);
        return genericNodeToTsType(node) + '[]';
      }
      return `${toEnglishName(param.schemaValue)}[]`;
    }
    return 'unknown[]';
  }
  if (t === 'object') return 'Record<string, unknown>';

  if (param.schema && param.schemaValue) {
    if (param.schemaValue.includes('«')) {
      const node = parseGenericType(param.schemaValue);
      return genericNodeToTsType(node);
    }
    return toEnglishName(param.schemaValue);
  }

  return 'unknown';
}

function resolveBodyTsType(param: ParsedParameter): string {
  if (param.type === 'array' && param.schemaValue) {
    if (param.schemaValue.includes('«')) {
      const node = parseGenericType(param.schemaValue);
      return genericNodeToTsType(node) + '[]';
    }
    return `${toEnglishName(param.schemaValue)}[]`;
  }
  if (param.schema && param.schemaValue) {
    if (param.schemaValue.includes('«')) {
      const node = parseGenericType(param.schemaValue);
      return genericNodeToTsType(node);
    }
    return toEnglishName(param.schemaValue);
  }
  return 'Record<string, unknown>';
}

function generateInterface(name: string, properties: ParsedProperty[], opts: Required<GenerateOptions>): string {
  const indent = ' '.repeat(opts.indentSize);
  const lines: string[] = [];

  lines.push(`export interface ${name} {`);
  for (const prop of properties) {
    const optional = prop.required ? '' : '?';
    const tsType = propertyToTsType(prop);
    if (opts.comments && prop.description) {
      lines.push(`${indent}/** ${prop.description} */`);
    }
    lines.push(`${indent}${prop.name}${optional}: ${tsType};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function propertyToTsType(prop: ParsedProperty): string {
  const t = prop.type;

  if (t === 'integer' || t.startsWith('integer(')) return 'number';
  if (t === 'number' || t.startsWith('number(')) return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string' || t.startsWith('string(')) return 'string';
  if (t === 'array') {
    if (prop.refType) {
      if (prop.refType.includes('«')) {
        const node = parseGenericType(prop.refType);
        const inner = genericNodeToTsType(node);
        return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
      }
      return `${toEnglishName(prop.refType)}[]`;
    }
    return 'unknown[]';
  }
  if (t === 'object') {
    if (prop.refType) {
      if (prop.refType.includes('«')) {
        const node = parseGenericType(prop.refType);
        return genericNodeToTsType(node);
      }
      return toEnglishName(prop.refType);
    }
    return 'Record<string, unknown>';
  }

  if (prop.refType) {
    if (prop.refType.includes('«')) {
      const node = parseGenericType(prop.refType);
      return genericNodeToTsType(node);
    }
    return toEnglishName(prop.refType);
  }

  return 'unknown';
}
