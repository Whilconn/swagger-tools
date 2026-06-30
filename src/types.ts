/**
 * Swagger/OpenAPI 规范类型定义
 * 同时兼容 OAS 2.0 (Swagger) 和 OAS 3.0 规范
 */

// ============ 原始 Swagger/OAS 规范类型 ============

/** OAS 2.0 完整文档结构 */
export interface SwaggerSpec {
  swagger?: string;
  openapi?: string;
  info: OpenApiInfo;
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  produces?: string[];
  paths: Record<string, PathItem>;
  definitions?: Record<string, Schema>;
  components?: Components;
  tags?: TagObject[];
  securityDefinitions?: Record<string, SecurityScheme>;
  security?: SecurityRequirement[];
  'x-openapi'?: XOpenApi;
  extensions?: { 'x-setting'?: OpenApiSetting[]; 'x-markdownFiles'?: MarkdownTagObject[] };
}

export interface OpenApiInfo {
  title?: string;
  description?: string;
  version?: string;
  termsOfService?: string;
  contact?: { name?: string; email?: string; url?: string };
  license?: { name?: string; url?: string };
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  delete?: OperationObject;
  patch?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  trace?: OperationObject;
}

export interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  consumes?: string[];
  produces?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBody; // OAS3
  responses: Record<string, ResponseObject>;
  deprecated?: boolean;
  security?: SecurityRequirement[];
  schemes?: string[];
  'x-author'?: string;
  'x-order'?: number;
  extensions?: { 'x-author'?: string; 'x-order'?: number };
}

export interface ParameterObject {
  name?: string;
  in?: string; // query, header, path, formData, body
  description?: string;
  required?: boolean;
  type?: string;
  format?: string;
  schema?: Schema;
  items?: Schema;
  default?: unknown;
  enum?: string[];
  'x-example'?: unknown;
  allowEmptyValue?: boolean;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  $ref?: string;
}

export interface RequestBody {
  description?: string;
  content: Record<string, MediaType>;
  required?: boolean;
}

export interface MediaType {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface ResponseObject {
  description?: string;
  schema?: Schema;
  content?: Record<string, MediaType>; // OAS3
  headers?: Record<string, unknown>;
}

export interface Schema {
  type?: string;
  format?: string;
  $ref?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  description?: string;
  title?: string;
  example?: unknown;
  default?: unknown;
  enum?: string[];
  readOnly?: boolean;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  xml?: { name?: string; namespace?: string; prefix?: string; attribute?: boolean; wrapped?: boolean };
  externalDocs?: { url?: string; description?: string };
}

export interface Components {
  schemas?: Record<string, Schema>;
  securitySchemes?: Record<string, SecurityScheme>;
  parameters?: Record<string, ParameterObject>;
}

export interface TagObject {
  name: string;
  description?: string;
  'x-author'?: string;
  'x-order'?: number;
  extensions?: { 'x-author'?: string; 'x-order'?: number };
}

export interface SecurityScheme {
  type: string; // basic, apiKey, oauth2
  description?: string;
  name?: string;
  in?: string; // query, header
  flow?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: Record<string, string>;
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlows;
}

export interface OAuthFlows {
  implicit?: { authorizationUrl: string; scopes: Record<string, string> };
  password?: { tokenUrl: string; scopes: Record<string, string> };
  clientCredentials?: { tokenUrl: string; scopes: Record<string, string> };
  authorizationCode?: { authorizationUrl: string; tokenUrl: string; scopes: Record<string, string> };
}

export interface SecurityRequirement {
  [name: string]: string[];
}

export interface XOpenApi {
  'x-setting'?: OpenApiSetting;
  'x-markdownFiles'?: MarkdownTagObject[];
}

export interface OpenApiSetting {
  enableDebug?: boolean;
  enableFooter?: boolean;
  enableSearch?: boolean;
  enableOpenApi?: boolean;
  enableSwaggerModels?: boolean;
  language?: string;
  [key: string]: unknown;
}

export interface MarkdownTagObject {
  name: string;
  group?: string;
  children?: { title: string; content?: string }[];
}

// ============ 解析后的模型类型 ============

/** 解析后的属性 */
export interface ParsedProperty {
  name: string;
  type: string;
  refType: string | null;
  description: string;
  example: unknown;
  format: string;
  required: boolean;
  value: unknown;
  readOnly: boolean;
  enum: string[] | null;
  originProperty: Schema;
  validateStatus: boolean;
  validateInstance: ValidateInstance | null;
  properties: ParsedProperty[];
}

export interface ValidateInstance {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

/** 解析后的 Definition/Model */
export interface ParsedDefinition {
  name: string;
  ignoreFilterName: string;
  description: string;
  type: string;
  title: string;
  required: string[];
  properties: ParsedProperty[];
  value: Record<string, unknown>;
  init: boolean;
}

/** 解析后的接口参数 */
export interface ParsedParameter {
  name: string | null;
  ignoreFilterName: string | null;
  deprecated: boolean;
  allowEmptyValue: boolean;
  require: boolean;
  type: string | null;
  in: string | null;
  schema: boolean;
  schemaValue: string | null;
  value: unknown;
  validateStatus: boolean;
  validateInstance: ValidateInstance | null;
  def: ParsedDefinition | null;
  description: string | null;
  txtValue: string | null;
  enum: string[] | null;
  id: string;
  pid: string;
  level: number;
  show: boolean;
  readOnly: boolean;
  example: unknown;
  childrenTypes: string[];
  children: ParsedParameter[] | null;
  parentTypes: string[];
}

/** 解析后的响应码 */
export interface ParsedResponseCode {
  code: string;
  description: string;
  schema: string | null;
  responseParameterRefName: string | null;
  responseText: string | null;
  responseBasicType: boolean;
  responseValue: string | null;
  responseJson: unknown;
  responseParameters: ParsedParameter[];
  oas2: boolean;
  schemaTitle?: string;
}

/** 解析后的接口信息 */
export interface ParsedApiInfo {
  id: string;
  versionId: string;
  operationId: string;
  summary: string;
  description: string;
  url: string;
  originalUrl: string;
  showUrl: string;
  methodType: string;
  tags: string[];
  consumes: string[];
  produces: string[];
  parameters: ParsedParameter[];
  responseCodes: ParsedResponseCode[];
  responseParameterRefName: string | null;
  responseBasicType: boolean;
  responseText: string | null;
  deprecated: boolean;
  author: string;
  order: number;
  hasNew: boolean;
  hasChanged: boolean;
  basePathFlag: boolean;
  host: string | null;
  instanceId: string | null;
  securityFlag: boolean;
  securityKeys: string[] | null;
  ignoreParameters: Record<string, unknown> | null;
  includeParameters: Record<string, unknown> | null;
  hashCollections: string[];
  oas2: boolean;
  configurationDebugSupport: boolean;
  multipartResponseSchema: boolean;
  originalApiInfo: OperationObject;
}

/** 解析后的 Tag */
export interface ParsedTag {
  name: string;
  description: string;
  author: string;
  order: number;
  childrens: ParsedApiInfo[];
  hasNew: boolean;
  hasChanged: boolean;
}

/** 解析后的 Security 信息 */
export interface ParsedSecurity {
  id: string;
  name: string;
  type: string;
  in: string | null;
  value: string;
  description: string | null;
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlows;
}

/** 解析后的完整实例 */
export interface ParsedInstance {
  id: string;
  name: string;
  url: string | null;
  groupVersion: string;
  basePath: string;
  host: string;
  title: string;
  description: string;
  version: string;
  termsOfService: string;
  contact: string;
  tags: ParsedTag[];
  paths: ParsedApiInfo[];
  definitions: ParsedDefinition[];
  securityArrs: ParsedSecurity[];
  swaggerData: SwaggerSpec | null;
}
