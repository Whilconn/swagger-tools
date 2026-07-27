/**
 * Swagger 数据解析器
 *
 * 同时支持 OAS 2.0 和 OAS 3.0 规范
 *
 * 核心解析流程：
 * 1. 解析基础信息 (info, host, basePath 等)
 * 2. 解析 Definitions/Models (数据模型)
 * 3. 解析 Tags (标签分组)
 * 4. 解析 Paths (接口路径与操作)
 * 5. 解析 Security (安全认证)
 */
import crypto from 'node:crypto';
import type {
  SwaggerSpec, Schema, ParameterObject, OperationObject,
  SecurityScheme, TagObject,
  ParsedInstance, ParsedDefinition, ParsedProperty, ParsedParameter,
  ParsedApiInfo, ParsedTag, ParsedSecurity, ParsedResponseCode,
  ValidateInstance,
} from './types.ts';
import {
  isBasicType, getBasicTypeValue, getClassName,
  getValue, propValue, getExample, checkUndefined, strNotBlank, strBlank,
  arrNotEmpty, arrEmpty, checkParamArrsExists, validateJSR303,
  appendBasePath, enumAvailableLabel, replaceMultipLineStr,
  checkPropertiesExists, uniqueId,
} from './utils.ts';

const SUPPORT_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'trace', 'head'] as const;

/** 判断是否是 OAS 2.0 规范 */
function isOas2(spec: SwaggerSpec): boolean {
  const version = spec.swagger || spec.openapi || '';
  return !version.startsWith('3');
}

/** 生成 MD5 哈希 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex');
}

// ============ 公共解析方法 ============

/**
 * 解析 Swagger/OpenAPI 规范数据，返回结构化的 ParsedInstance
 */
export function parseSwaggerSpec(spec: SwaggerSpec, groupName = 'default'): ParsedInstance {
  const oas2 = isOas2(spec);

  const instance: ParsedInstance = {
    id: md5(groupName),
    name: groupName,
    url: null,
    groupVersion: spec.swagger || spec.openapi || '2.0',
    basePath: spec.basePath || '',
    host: spec.host || '',
    title: spec.info?.title || '',
    description: spec.info?.description || '',
    version: spec.info?.version || '',
    termsOfService: spec.info?.termsOfService || '',
    contact: spec.info?.contact ? `${spec.info.contact.name || ''} ${spec.info.contact.email || ''}`.trim() : '',
    tags: [],
    paths: [],
    definitions: [],
    securityArrs: [],
    swaggerData: spec,
  };

  // 1. 解析 Definitions/Models
  parseDefinitions(spec, instance, oas2);

  // 2. 解析 Tags
  parseTags(spec, instance, oas2);

  // 3. 解析 Paths
  parsePaths(spec, instance, oas2);

  // 4. 解析 Security
  parseSecurity(spec, instance, oas2);

  // 5. 将 paths 分配到 tag.childrens
  assignPathsToTags(instance);

  return instance;
}

// ============ Definitions 解析 ============

/** 获取 definitions 对象 (OAS2: definitions, OAS3: components.schemas) */
function getDefinitions(spec: SwaggerSpec, oas2: boolean): Record<string, Schema> {
  if (oas2) {
    return spec.definitions || {};
  }
  return spec.components?.schemas || {};
}

/** 解析所有 Definition，创建 ParsedDefinition 列表 */
function parseDefinitions(spec: SwaggerSpec, instance: ParsedInstance, oas2: boolean): void {
  const definitions = getDefinitions(spec, oas2);

  for (const [name, schema] of Object.entries(definitions)) {
    const def = createDefinition(name, schema, definitions, oas2);
    instance.definitions.push(def);
  }
}

/** 创建单个 ParsedDefinition */
function createDefinition(name: string, schema: Schema, definitions: Record<string, Schema>, oas2: boolean): ParsedDefinition {
  const def: ParsedDefinition = {
    name,
    ignoreFilterName: name,
    description: propValue('description', schema as unknown as Record<string, unknown>, ''),
    type: propValue('type', schema as unknown as Record<string, unknown>, ''),
    title: propValue('title', schema as unknown as Record<string, unknown>, ''),
    required: schema.required || [],
    properties: [],
    value: {},
    init: false,
  };

  if (schema.properties) {
    const defiTypeValue: Record<string, unknown> = {};

    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const prop = parseProperty(propName, propSchema, def.required, name, definitions, oas2);
      if (!checkPropertiesExists(def.properties, { name: propName })) {
        def.properties.push(prop);
        if (!prop.readOnly) {
          defiTypeValue[propName] = prop.value;
        }
      }
    }

    def.value = defiTypeValue;
  }

  def.init = true;
  return def;
}

/** 解析单个属性 */
function parseProperty(
  name: string, schema: Schema, requiredArr: string[], parentName: string,
  definitions: Record<string, Schema>, oas2: boolean
): ParsedProperty {
  const propObj = schema as unknown as Record<string, unknown>;
  const validation = validateJSR303(propObj);

  const prop: ParsedProperty = {
    name,
    type: propValue('type', propObj, 'string'),
    refType: null,
    description: propValue('description', propObj, ''),
    example: schema.type === 'string'
      ? getExample('example', propObj, '')
      : propValue('example', propObj, ''),
    format: propValue('format', propObj, ''),
    required: propValue('required', propObj, false),
    value: '',
    readOnly: propValue('readOnly', propObj, false),
    enum: schema.enum || null,
    originProperty: schema,
    validateStatus: validation.status,
    validateInstance: validation.instance,
    properties: [],
  };

  // 检查 required
  if (requiredArr.includes(name)) {
    prop.required = true;
  }

  // 枚举描述
  if (schema.enum) {
    if (prop.description !== '') prop.description += ',';
    prop.description += enumAvailableLabel(schema.enum);
  }

  // 解析 type 与 refType
  prop.value = resolvePropertyValue(schema, parentName, definitions, oas2, prop);

  // 格式化 type
  if (strNotBlank(prop.format)) {
    prop.type += `(${prop.format})`;
  }

  // 最终类型修正
  if (strNotBlank(prop.refType) && prop.type === 'string') {
    prop.type = prop.refType!;
  }

  return prop;
}

/** 解析属性的值，处理 $ref、array、additionalProperties 等 */
function resolvePropertyValue(
  schema: Schema, parentName: string,
  definitions: Record<string, Schema>, oas2: boolean, prop: ParsedProperty
): unknown {
  const propObj = schema as unknown as Record<string, unknown>;

  if (schema.type) {
    const type = schema.type;

    if (schema.example !== undefined) {
      // 即便存在 example，也需先解析 array 的 refType，
      // 避免后续生成代码时因 refType 缺失而输出 unknown[]。
      if (type === 'array' && schema.items) {
        const items = schema.items;
        const ref = items.$ref;
        const className = getClassName(ref, oas2);
        if (className) {
          prop.refType = className;
        } else if (items.type) {
          prop.refType = items.type;
          if (isBasicType(items.type)) {
            const fmt = items.format;
            if (strNotBlank(fmt)) {
              prop.refType = `${items.type}(${fmt})`;
            }
          }
        }
      }
      return type === 'string' ? getExample('example', propObj, '') : schema.example;
    }

    if (isBasicType(type)) {
      let propValue = getBasicTypeValue(type);

      // object 类型处理 additionalProperties
      if (type === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const addpties = schema.additionalProperties;
        const addRefType = resolveRefType(addpties, oas2);
        if (strNotBlank(addRefType)) {
          const refName = addRefType as string;
          prop.refType = refName;
          const globalArr = [parentName];
          const addTempValue = refName !== parentName
            ? findRefDefinition(refName, definitions, false, globalArr, null, oas2)
            : findRefDefinition(refName, definitions, true, globalArr, parentName, oas2);
          propValue = { additionalProperties1: addTempValue };
          prop.type = refName;
          prop.refType = refName;
        } else if (addpties.$ref) {
          const className = getClassName(addpties.$ref, oas2);
          if (className) {
            prop.refType = className;
            const globalArr = [parentName];
            const addTempValue = className !== parentName
              ? findRefDefinition(className, definitions, false, globalArr, null, oas2)
              : findRefDefinition(className, definitions, true, globalArr, parentName, oas2);
            propValue = { additionalProperties1: addTempValue };
            prop.type = className;
          }
        } else if (addpties.items?.$ref) {
          const className = getClassName(addpties.items.$ref, oas2);
          if (className) {
            prop.refType = className;
            const globalArr = [parentName];
            const addTempValue = className !== parentName
              ? findRefDefinition(className, definitions, false, globalArr, null, oas2)
              : findRefDefinition(className, definitions, true, globalArr, parentName, oas2);
            propValue = { additionalProperties1: [addTempValue] };
            prop.type = 'array';
          }
        }
      }

      return propValue;
    }

    if (type === 'array') {
      const propValue: unknown[] = [];
      const items = schema.items;
      if (items) {
        const ref = items.$ref;
        const className = getClassName(ref, oas2);
        if (className) {
          prop.refType = className;
          const globalArr = [parentName];
          if (className !== parentName) {
            propValue.push(findRefDefinition(className, definitions, false, globalArr, null, oas2));
          } else {
            propValue.push(findRefDefinition(className, definitions, true, globalArr, parentName, oas2));
          }
        } else if (items.type) {
          prop.refType = items.type;
          if (isBasicType(items.type)) {
            const fmt = items.format;
            if (strNotBlank(fmt)) {
              prop.refType = `${items.type}(${fmt})`;
            }
          }
        }
      }
      return propValue;
    }
  }

  // 无 type，只有 $ref
  if (schema.$ref) {
    const className = getClassName(schema.$ref, oas2);
    if (className) {
      prop.refType = className;
      const globalArr = [parentName];
      if (className !== parentName) {
        return findRefDefinition(className, definitions, false, globalArr, null, oas2);
      } else {
        return findRefDefinition(className, definitions, true, globalArr, parentName, oas2);
      }
    }
  }

  return {};
}

/** 从 schema 中解析 refType (包括 additionalProperties 中的引用) */
function resolveRefType(schema: Schema, oas2: boolean): string | null {
  if (schema.$ref) {
    return getClassName(schema.$ref, oas2);
  }
  if (schema.type === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    return resolveRefType(schema.additionalProperties, oas2);
  }
  if (schema.type === 'array' && schema.items) {
    if (schema.items.$ref) return getClassName(schema.items.$ref, oas2);
  }
  return null;
}

/** 递归查找引用定义的值 */
function findRefDefinition(
  definitionName: string, definitions: Record<string, Schema>,
  flag: boolean, globalArr: string[], xname: string | null, oas: boolean
): Record<string, unknown> {
  if (globalArr.includes(definitionName) && flag) {
    return {};
  }

  const schema = definitions[definitionName];
  if (!schema || !schema.properties) return {};

  const defiTypeValue: Record<string, unknown> = {};

  for (const [property, propSchema] of Object.entries(schema.properties)) {
    if (propSchema.readOnly) continue;

    let propValue: unknown = '';

    if (propSchema.type) {
      const type = propSchema.type;

      if (propSchema.example !== undefined) {
        propValue = type === 'string' ? getExample('example', propSchema as unknown as Record<string, unknown>, '') : propSchema.example;
      } else if (propSchema.default !== undefined) {
        propValue = getExample('default', propSchema as unknown as Record<string, unknown>, '');
      } else if (isBasicType(type)) {
        propValue = getBasicTypeValue(type);

        // object + additionalProperties
        if (type === 'object' && propSchema.additionalProperties && typeof propSchema.additionalProperties === 'object') {
          const addpties = propSchema.additionalProperties;
          const addRefType = resolveRefType(addpties, oas);
          if (strNotBlank(addRefType)) {
            const refName = addRefType as string;
            if (!globalArr.includes(refName)) {
              globalArr.push(refName);
              const addTempValue = findRefDefinition(refName, definitions, flag, globalArr, xname, oas);
              propValue = { additionalProperties1: addTempValue };
            }
          } else if (addpties.$ref) {
            const className = getClassName(addpties.$ref, oas);
            if (className && !flag && !globalArr.includes(className)) {
              globalArr.push(className);
              const addTempValue = findRefDefinition(className, definitions, flag, globalArr, xname, oas);
              propValue = { additionalProperties1: addTempValue };
            }
          }
        }
      } else if (type === 'array') {
        propValue = [];
        const items = propSchema.items;
        if (items) {
          const ref = items.$ref;
          const className = getClassName(ref, oas);
          if (className) {
            if (!flag) {
              if (globalArr.includes(className)) {
                propValue = [{}];
              } else {
                globalArr.push(definitionName);
                propValue = [findRefDefinition(className, definitions, flag, globalArr, xname, oas)];
              }
            }
          }
        }
      }
    } else if (propSchema.$ref) {
      const className = getClassName(propSchema.$ref, oas);
      if (className) {
        if (!flag) {
          if (globalArr.includes(className)) {
            propValue = {};
          } else {
            globalArr.push(definitionName);
            propValue = findRefDefinition(className, definitions, flag, globalArr, xname, oas);
          }
        }
      }
    } else {
      propValue = {};
    }

    defiTypeValue[property] = propValue;
  }

  return defiTypeValue;
}

// ============ Tags 解析 ============

function parseTags(spec: SwaggerSpec, instance: ParsedInstance, oas2: boolean): void {
  const tags = spec.tags || [];

  const parsedTags: ParsedTag[] = tags.map(tag => {
    let author = '';
    let order = 0;

    if (oas2) {
      author = tag['x-author'] || '';
      const ord = tag['x-order'];
      if (ord != null) order = typeof ord === 'number' ? ord : parseInt(String(ord), 10);
    } else {
      if (tag.extensions) {
        author = tag.extensions['x-author'] || '';
        const ord = tag.extensions['x-order'];
        if (ord != null) order = typeof ord === 'number' ? ord : parseInt(String(ord), 10);
      }
      // 兼容直接在 tag 上的 x-order
      if (order === 0 && tag['x-order'] != null) {
        order = typeof tag['x-order'] === 'number' ? tag['x-order'] : parseInt(String(tag['x-order']), 10);
      }
    }

    return {
      name: tag.name.replace(/\//g, '-'),
      description: tag.description || '',
      author,
      order,
      childrens: [],
      hasNew: false,
      hasChanged: false,
    };
  });

  // 排序
  if (parsedTags.length > 0) {
    parsedTags.sort((a, b) => a.order - b.order);
  } else {
    parsedTags.push({ name: 'default', description: 'default', author: '', order: 0, childrens: [], hasNew: false, hasChanged: false });
  }

  instance.tags = parsedTags;
}

// ============ Paths 解析 ============

function parsePaths(spec: SwaggerSpec, instance: ParsedInstance, oas2: boolean): void {
  const paths = spec.paths;
  if (!paths) return;

  const appendBasePathFlag = appendBasePath(paths as unknown as Record<string, unknown>, spec.basePath);

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;

    for (const method of SUPPORT_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const apiInfo = createApiInfo(path, method, operation, spec, instance, appendBasePathFlag, oas2);
      instance.paths.push(apiInfo);
    }
  }
}

/** 创建解析后的接口信息对象 */
function createApiInfo(
  path: string, method: string, operation: OperationObject,
  spec: SwaggerSpec, instance: ParsedInstance, appendBasePathFlag: boolean, oas2: boolean
): ParsedApiInfo {
  // 构建 URL
  let fullPath = '';
  const basePath = instance.basePath;
  const basePathFlag = strNotBlank(basePath) && basePath !== '/';

  if (oas2 && !appendBasePathFlag && checkUndefined(basePath)) {
    fullPath += basePath;
  }
  fullPath += path;

  const newurl = fullPath;
  const md5Str = newurl + method.toUpperCase();

  const swpinfo: ParsedApiInfo = {
    id: md5(md5Str),
    versionId: md5(JSON.stringify(operation)),
    operationId: operation.operationId || md5(md5Str),
    summary: (operation.summary || '').replace(/\//g, '-'),
    description: operation.description || '',
    url: newurl,
    originalUrl: newurl,
    showUrl: newurl,
    methodType: method.toUpperCase(),
    tags: arrNotEmpty(operation.tags) ? operation.tags! : ['default'],
    consumes: operation.consumes || ['application/x-www-form-urlencoded'],
    produces: operation.produces || ['*/*'],
    parameters: [],
    responseCodes: [],
    responseParameterRefName: null,
    responseBasicType: false,
    responseText: null,
    deprecated: operation.deprecated || false,
    author: '',
    order: 2147483647,
    hasNew: false,
    hasChanged: false,
    basePathFlag,
    host: instance.host || null,
    instanceId: instance.id,
    securityFlag: false,
    securityKeys: null,
    ignoreParameters: null,
    includeParameters: null,
    hashCollections: [],
    oas2,
    configurationDebugSupport: true,
    multipartResponseSchema: false,
    originalApiInfo: operation,
  };

  // summary 为空时使用 operationId
  if (strBlank(swpinfo.summary)) {
    swpinfo.summary = swpinfo.operationId;
  }

  // 读取扩展属性
  readApiInfoInstanceExt(swpinfo, operation, oas2);

  // 解析参数
  if (oas2) {
    parseParametersOAS2(operation, swpinfo, instance, oas2);
  } else {
    parseParametersOAS3(operation, swpinfo, instance, oas2);
  }

  // 解析响应
  parseResponses(operation, swpinfo, instance, oas2);

  return swpinfo;
}

/** 读取接口扩展属性 (x-author, x-order) */
function readApiInfoInstanceExt(swpinfo: ParsedApiInfo, operation: OperationObject, oas2: boolean): void {
  if (oas2) {
    if (operation['x-author']) swpinfo.author = operation['x-author'];
    if (operation['x-order'] != null) swpinfo.order = operation['x-order'];
  } else {
    if (operation.extensions) {
      if (operation.extensions['x-author']) swpinfo.author = operation.extensions['x-author'];
      if (operation.extensions['x-order'] != null) swpinfo.order = operation.extensions['x-order'];
    }
  }
}

// ============ OAS2 参数解析 ============

function parseParametersOAS2(
  operation: OperationObject, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const parameters = operation.parameters;
  if (!arrNotEmpty(parameters)) return;

  for (const param of parameters) {
    assembleParameter(param, swpinfo, instance, oas2);
  }
}

/** 组装 OAS2 参数 */
function assembleParameter(
  m: ParameterObject, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const mObj = m as unknown as Record<string, unknown>;
  const originalName = propValue('name', mObj, '');
  const inType = propValue('in', mObj, '');

  const minfo: ParsedParameter = {
    name: originalName,
    ignoreFilterName: originalName,
    deprecated: m.deprecated || false,
    allowEmptyValue: m.allowEmptyValue || false,
    require: m.required || false,
    type: propValue('type', mObj, ''),
    in: inType,
    schema: false,
    schemaValue: null,
    value: null,
    validateStatus: false,
    validateInstance: null,
    def: null,
    description: replaceMultipLineStr(propValue('description', mObj, '')),
    txtValue: null,
    enum: m.enum || null,
    id: uniqueId('param'),
    pid: '-1',
    level: 1,
    show: true,
    readOnly: false,
    example: null,
    childrenTypes: [],
    children: null,
    parentTypes: [],
  };

  // format
  const format = propValue('format', mObj, '');
  if (strNotBlank(format)) {
    minfo.type = `${minfo.type}(${format})`;
  }

  // 枚举
  if (m.enum) {
    if (minfo.description) {
      minfo.description = minfo.description + ',' + enumAvailableLabel(m.enum);
    } else {
      minfo.description = enumAvailableLabel(m.enum);
    }
  }

  // 默认值
  if ('default' in m) {
    minfo.txtValue = String(m.default);
    minfo.example = m.default;
  }
  if ('x-example' in m && m['x-example'] != null) {
    minfo.txtValue = String(m['x-example']);
    minfo.example = m['x-example'];
  }

  // schema 处理
  if (m.schema) {
    minfo.schema = true;
    const schemaObj = m.schema;
    const schemaType = schemaObj.type;

    if (schemaType === 'array') {
      minfo.type = schemaType;
      const schItem = schemaObj.items;
      if (schItem) {
        const className = getClassName(schItem.$ref, oas2);
        minfo.schemaValue = className;
        const def = className ? getDefinitionByName(className, instance.definitions) : null;
        if (def) {
          minfo.def = def;
          minfo.value = def.value;
          if (def.description) minfo.description = replaceMultipLineStr(def.description);
        } else if (schItem.type) {
          minfo.schemaValue = schItem.type;
          minfo.value = getBasicTypeValue(schItem.type);
          const fmt = schItem.format;
          if (strNotBlank(fmt)) {
            minfo.schemaValue = `${schItem.type}(${fmt})`;
          }
        }
      }
    } else if (schemaObj.$ref) {
      const className = getClassName(schemaObj.$ref, oas2);
      if (minfo.type !== 'array' && className) {
        minfo.type = className;
      }
      minfo.schemaValue = className;
      const def = className ? getDefinitionByName(className, instance.definitions) : null;
      if (def) {
        minfo.def = def;
        minfo.value = def.value;
        if (def.description) minfo.description = replaceMultipLineStr(def.description);
      }
    } else if (schemaObj.additionalProperties && typeof schemaObj.additionalProperties === 'object') {
      const addProp = schemaObj.additionalProperties as Schema;
      if (addProp.$ref) {
        const className = getClassName(addProp.$ref, oas2);
        if (className) {
          const def = getDefinitionByName(className, instance.definitions);
          if (def) {
            minfo.def = def;
            minfo.value = { additionalProperties1: def.value };
            if (def.description) minfo.description = replaceMultipLineStr(def.description);
          }
        }
      } else if (addProp.items?.$ref) {
        const className = getClassName(addProp.items.$ref, oas2);
        if (className) {
          const def = getDefinitionByName(className, instance.definitions);
          if (def) {
            minfo.def = def;
            minfo.value = { additionalProperties1: [def.value] };
            if (def.description) minfo.description = replaceMultipLineStr(def.description);
          }
        }
      }
    } else if (schemaObj.type) {
      minfo.type = schemaObj.type;
      minfo.value = '';
    }
  }

  // items 处理
  if (m.items) {
    const items = m.items;
    if (items.$ref) {
      const className = getClassName(items.$ref, oas2);
      minfo.schemaValue = className;
      const def = className ? getDefinitionByName(className, instance.definitions) : null;
      if (def) {
        minfo.def = def;
        minfo.value = def.value;
        if (def.description) minfo.description = replaceMultipLineStr(def.description);
      }
    } else if (items.type) {
      minfo.schemaValue = items.type;
      minfo.value = '';
    }
  }

  // body 参数的 txtValue 处理
  if (minfo.in === 'body' && minfo.value != null) {
    const val = minfo.type === 'array' ? [minfo.value] : minfo.value;
    minfo.txtValue = JSON.stringify(val, null, '\t');
  }

  // JSR-303
  const validation = validateJSR303(mObj);
  minfo.validateStatus = validation.status;
  minfo.validateInstance = validation.instance;

  // 去重添加
  if (!checkParamArrsExists(swpinfo.parameters, minfo)) {
    swpinfo.parameters.push(minfo);
    if (minfo.schema && minfo.schemaValue) {
      minfo.parentTypes.push(minfo.schemaValue);
    }
  }
}

// ============ OAS3 参数解析 ============

function parseParametersOAS3(
  operation: OperationObject, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const parameters = operation.parameters;
  if (arrNotEmpty(parameters)) {
    for (const param of parameters) {
      assembleParameter(param, swpinfo, instance, oas2);
    }
  }

  // OAS3 requestBody
  if (operation.requestBody) {
    const content = operation.requestBody.content;
    for (const [, mediaType] of Object.entries(content)) {
      if (mediaType.schema) {
        const param: ParameterObject = {
          name: 'requestBody',
          in: 'body',
          description: operation.requestBody.description,
          required: operation.requestBody.required,
          schema: mediaType.schema,
        };
        assembleParameter(param, swpinfo, instance, oas2);
      }
    }
  }
}

// ============ Responses 解析 ============

function parseResponses(
  operation: OperationObject, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const responses = operation.responses;
  if (!responses) return;

  for (const [status, respObj] of Object.entries(responses)) {
    const responseCode: ParsedResponseCode = {
      code: status,
      description: respObj.description || '',
      schema: null,
      responseParameterRefName: null,
      responseText: null,
      responseBasicType: false,
      responseValue: null,
      responseJson: null,
      responseParameters: [],
      oas2,
    };

    if (oas2) {
      parseResponseSchemaOAS2(respObj, responseCode, swpinfo, instance, oas2);
    } else {
      parseResponseSchemaOAS3(respObj, responseCode, swpinfo, instance, oas2);
    }

    swpinfo.responseCodes.push(responseCode);
  }
}

function parseResponseSchemaOAS2(
  respObj: { description?: string; schema?: Schema; content?: Record<string, unknown>; headers?: Record<string, unknown> },
  responseCode: ParsedResponseCode, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const schema = respObj.schema;
  if (!schema) return;

  let arr = false;
  let rptype: string | null = null;

  if (schema.$ref) {
    const match = getClassName(schema.$ref, oas2);
    if (match) {
      rptype = match;
      swpinfo.responseParameterRefName = rptype;
      responseCode.responseParameterRefName = rptype;
      responseCode.schema = rptype;
    }
  } else if (schema.type) {
    if (schema.type === 'array') {
      arr = true;
      const items = schema.items;
      if (items) {
        let itref = items.$ref;
        if (items.type === 'array' && items.items) {
          itref = items.items.$ref;
        }
        if (itref) {
          const match = getClassName(itref, oas2);
          if (match) {
            rptype = match;
            swpinfo.responseParameterRefName = rptype;
            responseCode.responseParameterRefName = rptype;
            responseCode.schema = rptype;
          }
        }
      }
    } else if (isBasicType(schema.type)) {
      swpinfo.responseText = schema.type;
      swpinfo.responseBasicType = true;
      responseCode.responseText = schema.type;
      responseCode.responseBasicType = true;
      const fmt = schema.format;
      if (strNotBlank(fmt)) {
        responseCode.schemaTitle = `${schema.type}(${fmt})`;
      } else {
        responseCode.schemaTitle = schema.type;
      }
    }
  }

  if (rptype) {
    const def = getDefinitionByName(rptype, instance.definitions);
    if (def) {
      if (arr) {
        const na = [def.value];
        responseCode.responseValue = JSON.stringify(na, null, '\t');
        responseCode.responseJson = na;
      } else {
        responseCode.responseValue = JSON.stringify(def.value, null, '\t');
        responseCode.responseJson = def.value;
      }
    }
  }
}

function parseResponseSchemaOAS3(
  respObj: { description?: string; schema?: Schema; content?: Record<string, { schema?: Schema }>; headers?: Record<string, unknown> },
  responseCode: ParsedResponseCode, swpinfo: ParsedApiInfo,
  instance: ParsedInstance, oas2: boolean
): void {
  const content = respObj.content;
  if (!content) return;

  // 取第一个 content type
  for (const [, mediaType] of Object.entries(content)) {
    const schema = mediaType.schema;
    if (!schema) continue;

    let arr = false;
    let rptype: string | null = null;

    if (schema.$ref) {
      const match = getClassName(schema.$ref, oas2);
      if (match) {
        rptype = match;
        swpinfo.responseParameterRefName = rptype;
        responseCode.responseParameterRefName = rptype;
        responseCode.schema = rptype;
      }
    } else if (schema.type === 'array' && schema.items) {
      arr = true;
      const items = schema.items;
      if (items.$ref) {
        const match = getClassName(items.$ref, oas2);
        if (match) {
          rptype = match;
          swpinfo.responseParameterRefName = rptype;
          responseCode.responseParameterRefName = rptype;
          responseCode.schema = rptype;
        }
      }
    } else if (schema.type && isBasicType(schema.type)) {
      swpinfo.responseText = schema.type;
      swpinfo.responseBasicType = true;
      responseCode.responseText = schema.type;
      responseCode.responseBasicType = true;
      const fmt = schema.format;
      responseCode.schemaTitle = strNotBlank(fmt) ? `${schema.type}(${fmt})` : schema.type;
    }

    if (rptype) {
      const def = getDefinitionByName(rptype, instance.definitions);
      if (def) {
        if (arr) {
          const na = [def.value];
          responseCode.responseValue = JSON.stringify(na, null, '\t');
          responseCode.responseJson = na;
        } else {
          responseCode.responseValue = JSON.stringify(def.value, null, '\t');
          responseCode.responseJson = def.value;
        }
      }
    }
    break; // 只处理第一个 content type
  }
}

// ============ Security 解析 ============

function parseSecurity(spec: SwaggerSpec, instance: ParsedInstance, oas2: boolean): void {
  const securityDefs = oas2 ? spec.securityDefinitions : spec.components?.securitySchemes;

  if (!securityDefs) return;

  for (const [name, scheme] of Object.entries(securityDefs)) {
    const security: ParsedSecurity = {
      id: uniqueId('sec'),
      name,
      type: scheme.type,
      in: scheme.in || null,
      value: '',
      description: scheme.description || null,
    };

    if (scheme.scheme) security.scheme = scheme.scheme;
    if (scheme.bearerFormat) security.bearerFormat = scheme.bearerFormat;
    if (scheme.flows) security.flows = scheme.flows;

    instance.securityArrs.push(security);
  }
}

// ============ 辅助方法 ============

function getDefinitionByName(name: string, definitions: ParsedDefinition[]): ParsedDefinition | null {
  return definitions.find(d => d.name === name) || null;
}

/** 将 paths 分配到对应的 tag 分组 */
function assignPathsToTags(instance: ParsedInstance): void {
  for (const tag of instance.tags) {
    for (const apiInfo of instance.paths) {
      if (apiInfo.tags.includes(tag.name)) {
        if (!strNotBlank(apiInfo.author) && strNotBlank(tag.author)) {
          apiInfo.author = tag.author;
        }
        tag.childrens.push(apiInfo);
      }
    }

    // 按 order 排序
    tag.childrens.sort((a, b) => a.order - b.order);
  }
}
