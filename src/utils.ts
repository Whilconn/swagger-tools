/**
 * 工具函数
 */
import type { Schema, ValidateInstance } from './types.ts';

const BASIC_TYPES = ['string', 'integer', 'number', 'object', 'boolean', 'int32', 'int64', 'float', 'double'];

/** 判断是否是基本类型 */
export function isBasicType(type: string | undefined | null): boolean {
  if (type == null) return false;
  return BASIC_TYPES.includes(type);
}

/** 获取基本类型的默认值 */
export function getBasicTypeValue(type: string): unknown {
  switch (type) {
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'object':
      return {};
    case 'number':
      return 0;
    case 'double':
      return 0.5;
    case 'float':
      return 0.0;
    default:
      return '';
  }
}

/** 从 $ref 中提取类名 */
export function getClassName(ref: string | undefined, oas2: boolean): string | null {
  if (!ref) return null;
  const pattern = oas2 ? /^#\/definitions\/(.+)$/ : /^#\/components\/schemas\/(.+)$/;
  const match = ref.match(pattern);
  if (match) return match[1];

  // 兼容裸模型名 (缺少 #/definitions/ 或 #/components/schemas/ 前缀，如 "StudentSeriesReadDetailVo.StudentLevelReadVo")
  if (!ref.includes('#') && !ref.includes('/')) {
    return ref;
  }
  return null;
}

/** 从 $ref 中提取参数名 (OAS3 components/parameters) */
export function getRefParameterName(ref: string | undefined): string | null {
  if (!ref) return null;
  const match = ref.match(/^#\/components\/parameters\/(.+)$/);
  return match ? match[1] : null;
}

/** 获取 OAS 版本对应的 $ref 正则模式 */
export function oasModelPattern(oas2: boolean): RegExp {
  return oas2 ? /^#\/definitions\/(.+)$/ : /^#\/components\/schemas\/(.+)$/;
}

/** 安全获取对象属性值 */
export function getValue<T>(
  obj: Record<string, unknown> | null | undefined,
  key: string,
  defaultValue: T,
  checkEmpty = false,
): T {
  if (obj == null) return defaultValue;
  if (key in obj) {
    let val = obj[key] as T;
    if (checkEmpty && (val == null || val === '' || val === undefined)) {
      return defaultValue;
    }
    return val;
  }
  return defaultValue;
}

/** 安全获取属性值 */
export function propValue<T>(key: string, obj: Record<string, unknown>, defaultValue: T): T {
  return key in obj ? (obj[key] as T) : defaultValue;
}

/** 获取 example 值，处理数字精度和对象类型 */
export function getExample(key: string, obj: Record<string, unknown>, defaultValue: unknown): unknown {
  const v = propValue(key, obj, defaultValue);
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** 检查值是否非空非undefined */
export function checkUndefined(obj: unknown): boolean {
  return obj !== undefined && obj !== null;
}

/** 检查字符串是否非空 */
export function strNotBlank(str: string | null | undefined): boolean {
  return str !== undefined && str !== null && str !== '';
}

/** 检查字符串是否为空 */
export function strBlank(str: string | null | undefined): boolean {
  return !strNotBlank(str);
}

/** 检查数组是否非空 */
export function arrNotEmpty<T>(arr: T[] | null | undefined): arr is T[] {
  return arr != null && arr.length > 0;
}

/** 检查数组是否为空 */
export function arrEmpty<T>(arr: T[] | null | undefined): boolean {
  return !arrNotEmpty(arr);
}

/** 判断参数是否在参数数组中已存在 */
export function checkParamArrsExists(
  arr: { name: string | null; in: string | null }[],
  param: { name: string | null; in: string | null },
): boolean {
  return arr.some((row) => `${row.name ?? ''}${row.in ?? ''}` === `${param.name ?? ''}${param.in ?? ''}`);
}

/** JSR-303 校验注解解析 */
export function validateJSR303(origin: Record<string, unknown>): {
  status: boolean;
  instance: ValidateInstance | null;
} {
  const max = origin['maximum'] as number | undefined;
  const min = origin['minimum'] as number | undefined;
  const emin = origin['exclusiveMinimum'] as number | undefined;
  const emax = origin['exclusiveMaximum'] as number | undefined;
  const pattern = origin['pattern'] as string | undefined;
  const maxLength = origin['maxLength'] as number | undefined;
  const minLength = origin['minLength'] as number | undefined;

  if (max != null || min != null || emin != null || emax != null) {
    return { status: true, instance: { minimum: min, maximum: max, exclusiveMinimum: emin, exclusiveMaximum: emax } };
  }
  if (pattern) {
    return { status: true, instance: { pattern } };
  }
  if (maxLength != null || minLength != null) {
    return { status: true, instance: { maxLength, minLength } };
  }
  return { status: false, instance: null };
}

/** 判断 basePath 是否已经被追加到 paths 中 */
export function appendBasePath(paths: Record<string, unknown>, basePath: string | undefined): boolean {
  try {
    if (!strBlank(basePath) && basePath !== '/') {
      const pathKeys = Object.keys(paths);
      if (pathKeys.length === 0) return true;
      const basePathStr = basePath + '/';
      const num = pathKeys.filter((k) => k.startsWith(basePathStr)).length;
      // 如果超过 60% 的 path 已经包含 basePath，则认为已经追加过
      if (num === pathKeys.length || (pathKeys.length > 0 && (num / pathKeys.length) * 100 >= 60)) {
        return true;
      }
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** 格式化枚举可用值标签 */
export function enumAvailableLabel(enumCollection: string[]): string {
  return '可用值:' + enumCollection.join(',');
}

/** 替换多行字符串中的换行符 */
export function replaceMultipLineStr(str: string | null): string {
  if (str == null || str === '') return '';
  return str.replace(/(\r\n|\n\r|\r|\n)/g, '\\n');
}

/** 判断属性是否已存在于属性列表中 */
export function checkPropertiesExists(
  properties: { name: string; in?: string; type?: string }[],
  prop: { name: string; in?: string; type?: string },
): boolean {
  return properties.some((p) => p.name === prop.name && p.in === prop.in && p.type === prop.type);
}

/** 生成简易唯一 ID */
let _idCounter = 0;
export function uniqueId(prefix: string): string {
  return `${prefix}${++_idCounter}`;
}
