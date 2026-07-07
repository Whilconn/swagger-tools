/**
 * 根据 ParsedApiInfo 生成 fetch 请求代码
 */
import type { ParsedApiInfo, ParsedParameter, ParsedDefinition, ParsedProperty, ParsedInstance } from './types.ts';

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
  '通用返回封装对象': 'CommonResponse',
  '通用返回封装': 'CommonResponse',
  '返回结果封装对象': 'ResultResponse',
  '返回结果': 'Result',
};

/** 将含中文的类型名转为英文 */
function toEnglishTypeName(name: string): string {
  // 直接命中映射
  if (CHINESE_TYPE_MAP[name]) return CHINESE_TYPE_MAP[name]!;

  // 包含中文时，尝试部分匹配
  if (/[\u4e00-\u9fff]/.test(name)) {
    for (const [cn, en] of Object.entries(CHINESE_TYPE_MAP)) {
      if (name.includes(cn)) return en;
    }
    // 无法映射的中文类型，用 Type 前缀 + 纯 ASCII 部分
    const asciiPart = name.replace(/[\u4e00-\u9fff«»]/g, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    return asciiPart ? `Type${asciiPart}` : 'UnknownType';
  }

  // 纯 ASCII，清理特殊字符
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'UnknownType';
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

/** 外层类型名转英文 */
function toEnglishName(name: string): string {
  // List 在 TS 中映射为 Array
  if (name === 'List' || name === 'list') return 'Array';
  return toEnglishTypeName(name);
}

/** 将 GenericTypeNode 转为 TypeScript 类型字符串 */
function genericNodeToTsType(node: GenericTypeNode): string {
  if (node.params.length === 0) {
    return node.name;
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

/** 生成响应相关的所有 interface 定义 */
function generateResponseTypes(
  responseNode: GenericTypeNode,
  definitions: ParsedDefinition[],
  opts: Required<GenerateOptions>,
): string[] {
  const collected = new Set<string>();
  collectResponseTypes(responseNode, definitions, collected);

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
        interfaces.push(generateGenericInterface(enName, def, responseNode, definitions, opts));
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

/** 生成泛型 interface (如 ApiResponse<T>) */
function generateGenericInterface(
  enName: string,
  def: ParsedDefinition,
  responseNode: GenericTypeNode,
  definitions: ParsedDefinition[],
  opts: Required<GenerateOptions>,
): string {
  const indent = ' '.repeat(opts.indentSize);
  const lines: string[] = [];

  // 泛型参数名
  const typeParam = 'T';
  lines.push(`export interface ${enName}<${typeParam}> {`);

  for (const prop of def.properties) {
    const optional = prop.required ? '' : '?';
    let tsType: string;

    // data 字段使用泛型参数 T
    if (prop.name === 'data') {
      tsType = typeParam;
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

  // 生成 TypeScript 类型定义
  if (opts.types) {
    // 请求 body 类型
    if (bodyParams.length > 0 && bodyParams[0]!.def) {
      const def = bodyParams[0]!.def;
      const reqTypeName = toEnglishName(def.name);
      lines.push(generateInterface(reqTypeName, def.properties, opts));
      lines.push('');
    }

    // 响应类型
    if (responseNode) {
      const responseInterfaces = generateResponseTypes(responseNode, definitions, opts);
      for (const iface of responseInterfaces) {
        lines.push(iface);
        lines.push('');
      }
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

  // 生成 TypeScript 类型定义
  if (opts.types) {
    if (bodyParams.length > 0 && bodyParams[0]!.def) {
      const def = bodyParams[0]!.def;
      const reqTypeName = toEnglishName(def.name);
      lines.push(generateInterface(reqTypeName, def.properties, opts));
      lines.push('');
    }
    if (responseNode) {
      const responseInterfaces = generateResponseTypes(responseNode, definitions, opts);
      for (const iface of responseInterfaces) {
        lines.push(iface);
        lines.push('');
      }
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
