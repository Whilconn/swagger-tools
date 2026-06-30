/**
 * 根据 ParsedApiInfo 生成 fetch 请求代码
 */
import type { ParsedApiInfo, ParsedParameter, ParsedDefinition, ParsedProperty } from './types.js';

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

/**
 * 根据 ParsedApiInfo 生成 fetch 请求代码
 */
export function generateFetchCode(api: ParsedApiInfo, options?: GenerateOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indent = ' '.repeat(opts.indentSize);

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
      funcParams.push(`data: ${bp.def.name}`);
    } else {
      funcParams.push(`data: ${resolveBodyTsType(bp)}`);
    }
  }
  if (formDataParams.length > 0) {
    funcParams.push(`data: FormData`);
  }

  const funcParamsStr = funcParams.length > 0 ? `\n${funcParams.map(p => `${indent}${p}`).join(',\n')}\n` : '';

  // 响应类型
  const response200 = api.responseCodes.find(r => r.code === '200');
  const returnType = response200?.schema || 'unknown';

  // 生成 TypeScript 类型
  if (opts.types) {
    // 请求 body 类型
    if (bodyParams.length > 0 && bodyParams[0]!.def) {
      const def = bodyParams[0]!.def;
      lines.push(generateInterface(def.name, def.properties, opts));
      lines.push('');
    }
    // 响应类型
    if (response200?.schema) {
      lines.push(`type ${sanitizeTypeName(returnType)}Response = unknown;`);
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
  if (opts.types) {
    lines.push(`export async function ${functionName}(${funcParamsStr}): Promise<${sanitizeTypeName(returnType)}Response> {`);
  } else {
    lines.push(`export async function ${functionName}(${funcParamsStr}) {`);
  }

  // 构建请求选项 (函数体内缩进2层)
  const i1 = indent;        // 1层
  const i2 = indent + indent; // 2层
  const i3 = i2 + indent;   // 3层

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

  // Query string — fetch 不支持 params, 改拼 URL
  if (queryParams.length > 0) {
    lines.push(`${i1}const params = new URLSearchParams();`);
    for (const qp of queryParams) {
      const val = qp.require
        ? `${toSafeParamName(qp.name!)}`
        : `${toSafeParamName(qp.name!)}`;
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

  // 构建 fetch 调用
  lines.push(`${i1}const response = await fetch(${finalUrlExpr}, {`);
  lines.push(...fetchInitLines);
  lines.push(`${i1}});`);
  lines.push('');
  lines.push(`${i1}if (!response.ok) {`);
  lines.push(`${i2}throw new Error(\`HTTP error! status: \${response.status}\`);`);
  lines.push(`${i1}}`);
  lines.push('');
  if (opts.types) {
    lines.push(`${i1}return response.json() as Promise<${sanitizeTypeName(returnType)}Response>;`);
  } else {
    lines.push(`${i1}return response.json();`);
  }
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

  // Headers
  const contentType = api.consumes[0] || 'application/json';
  if (bodyParams.length > 0) {
    parts.push(`  -H 'Content-Type: ${contentType}' \\`);
  }
  parts.push(`  -H 'Accept: ${api.produces[0] || '*/*'}' \\`);
  for (const hp of headerParams) {
    const val = hp.example ?? `<${hp.name}>`;
    parts.push(`  -H '${hp.name}: ${val}' \\`);
  }

  // Body
  if (bodyParams.length > 0) {
    const bp = bodyParams[0]!;
    const bodyVal = bp.txtValue || (bp.value ? JSON.stringify(bp.value) : '{}');
    // 单行化
    const oneLine = bodyVal.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    parts.push(`  -d '${oneLine}' \\`);
  }

  // 去掉末尾的 \
  const last = parts[parts.length - 1]!;
  parts[parts.length - 1] = last.replace(/ \\$/, '');

  return parts.join('\n');
}

// ============ 辅助函数 ============

function toCamelCase(str: string): string {
  // operationId 如 queryStudentReadUsingPOST -> queryStudentRead
  let name = str.replace(/Using(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i, '');
  // 首字母小写
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function toSafeParamName(name: string): string {
  // 处理 kebab-case 等
  return name.replace(/[-\s](\w)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

function resolveTsType(param: ParsedParameter): string {
  const t = param.type;
  if (!t) return 'unknown';

  if (t === 'integer' || t.startsWith('integer(')) return 'number';
  if (t === 'number' || t.startsWith('number(')) return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string' || t.startsWith('string(')) return 'string';
  if (t === 'array') {
    if (param.schemaValue) return `${sanitizeTypeName(param.schemaValue)}[]`;
    return 'unknown[]';
  }
  if (t === 'object') return 'Record<string, unknown>';

  // 引用类型
  if (param.schema && param.schemaValue) return sanitizeTypeName(param.schemaValue);

  return 'unknown';
}

function resolveBodyTsType(param: ParsedParameter): string {
  if (param.type === 'array' && param.schemaValue) {
    return `${sanitizeTypeName(param.schemaValue)}[]`;
  }
  if (param.schema && param.schemaValue) {
    return sanitizeTypeName(param.schemaValue);
  }
  return 'Record<string, unknown>';
}

function sanitizeTypeName(name: string): string {
  // 将泛型 A«B«C»» 转为 A_B_C 等可读形式
  // 先将 « 替换为 _ ，» 删除
  let result = name
    .replace(/«/g, '_')
    .replace(/»/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  // 如果包含非 ASCII 字符(如中文)，保留它们但替换其他特殊字符
  result = result.replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_');
  // 清理连续下划线
  result = result.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return result || 'UnknownType';
}

function generateInterface(name: string, properties: ParsedProperty[], opts: Required<GenerateOptions>): string {
  const indent = ' '.repeat(opts.indentSize);
  const lines: string[] = [];

  lines.push(`export interface ${sanitizeTypeName(name)} {`);
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
    if (prop.refType) return `${sanitizeTypeName(prop.refType)}[]`;
    return 'unknown[]';
  }
  if (t === 'object') {
    if (prop.refType) return sanitizeTypeName(prop.refType);
    return 'Record<string, unknown>';
  }

  // 引用类型
  if (prop.refType) return sanitizeTypeName(prop.refType);

  return 'unknown';
}
