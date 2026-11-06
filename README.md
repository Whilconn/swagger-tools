# swagger-tools

一个轻量的 **Swagger / OpenAPI（OAS 2.0 & 3.0）解析 + 前端请求代码生成** 工具。

它可以读取本地或远程的 Swagger 规范，按 `tag` 或接口路径筛选接口，并直接生成 **fetch / axios / cURL** 调用代码以及配套的 **TypeScript 类型定义**。生成的代码是零依赖的纯 TS 函数，可以直接放进项目里使用或二次封装。

## 特性

- **双规范兼容**：同时支持 OAS 2.0（`swagger: "2.0"`）与 OAS 3.0（`openapi: "3.x"`），自动识别版本并选择 `definitions` 或 `components.schemas`。
- **多种筛选方式**：按 `tags` 分组生成，或按接口路径（支持部分路径匹配）生成。
- **三种输出格式**：`fetch`、`axios`、`curl`。
- **类型定义自动补全**：递归追踪 `$ref` 引用链，生成完整的 `interface`，自动去重，跨接口合并时不会重复定义。
- **泛型还原**：支持 `分页封装对象«UserVo»` 这类泛型写法，输出为 `PageResponse<UserVo>`，并把数据载体字段（`data` / `result` / `list` …）替换为泛型参数 `T`。
- **中文模型名转写**：基于 `pinyin-pro` 将中文模型名转成可读的英文类型名（如 `接口统一返回封装对象` → `ApiResponse`，`学生成绩Vo` → `XueShengChengJiVo`），并对重名做自动去重。
- **配置即脚本**：配置文件为 `.mjs`，支持注释、变量、环境变量、条件判断等原生 JS 能力。
- **可编程调用**：`parseSwaggerSpec` / `generateFetchCode` / `generateAxiosCode` / `generateCurlCode` 均可单独在 Node 中作为库使用。

## 环境要求

- Node.js **>= 22.6**（依赖 `--experimental-strip-types` 直接运行 TS），项目 `volta` 锁定在 **24.7.0**
- TypeScript >= 5.7（使用 `rewriteRelativeImportExtensions`，构建时需要）

## 安装

```bash
npm install
```

构建（输出到 `dist/`，含 `.d.ts`）：

```bash
npm run build
```

本地全局使用 CLI：

```bash
npm link
swagger-tools --help
```

不构建也可以直接运行：

```bash
npm run cli -- api.json
```

## 快速开始

### 1. 准备配置文件

在项目根目录创建 `swagger-tools.config.mjs`（仓库内提供了 `swagger-tools.config.example.mjs` 可直接改名使用）：

```js
export default {
  // ---- 规范来源（二选一）----
  file: 'api.json',              // 本地文件，路径相对于当前工作目录
  // url: 'https://petstore.swagger.io/v2/swagger.json',  // 远程地址，优先级高于 file

  // ---- 生成目标（二选一，tags 优先）----
  tags: ['user-controller'],     // 每个 tag 生成一个 <tag>.ts
  // paths: ['/api/user/list'],  // 支持部分路径匹配，全部写入 paths.ts

  // ---- 可选 ----
  output: './output',            // 输出目录，省略则直接打印到终端
  baseUrl: 'https://api.example.com',
  format: 'fetch',               // fetch | axios | curl
  types: true,                   // 是否生成 TypeScript 类型
  comments: true,                // 是否生成注释
};
```

### 2. 执行生成

```bash
swagger-tools
```

无参数时会在当前目录按以下优先级自动查找配置：

```
swagger-tools.config.mjs
swagger-tools.config.js
swagger-tools.config.json
.swagger-toolsrc
.swagger-toolsrc.json
```

生成结果：

| 配置 | 输出文件 |
| --- | --- |
| `tags: ['user-controller']` + `output: './output'` | `output/user-controller.ts` |
| `paths: ['/api/user/list', '/api/user/get']` + `output: './output'` | `output/paths.ts`（多个接口合并，类型自动去重） |
| 未配置 `output` | 直接输出到终端，接口之间用 `===` 分隔线隔开 |

## CLI 用法

```bash
# 自动加载配置文件并执行生成
swagger-tools

# 指定配置文件
swagger-tools --config ./swagger-tools.config.mjs

# 解析模式：只打印规范摘要，不生成代码
swagger-tools api.json

# 解析模式：把解析后的结构化 JSON 写入文件
swagger-tools api.json parsed.json

# 帮助
swagger-tools --help
```

解析模式会输出标题、版本、BasePath、Host、模型数量、接口数量、Tag 分组数、安全方案数，以及每个 Tag 下的接口与参数、响应码明细。

## 输出示例

以 `GET /api/user/list`（分页查询用户，返回 `分页封装对象«UserVo»`）为例，`format: 'fetch'` 会生成：

```ts
// [GET] /api/user/list - 分页查询用户

export interface PageResponse<T> {
  total: number;
  list: T[];
}

export interface UserVo {
  id: number;
  name?: string;
}

/**
 * 分页查询用户
 */
export async function queryUserList(
  page?: number,
  size?: number
): Promise<PageResponse<UserVo>> {
  const params = new URLSearchParams();
  // 页码
  if (page != null) params.append('page', String(page));
  if (size != null) params.append('size', String(size));

  const response = await fetch('https://api.example.com' + '/api/user/list' + (params.toString() ? '?' + params.toString() : ''), {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}
```

切换 `format: 'axios'` 会生成对应的 `axios({ method, url, params, headers, data })` 调用；`format: 'curl'` 则输出可直接粘贴到终端执行的 `curl` 命令（使用 `example` / `default` 作为参数示例值）。

## 配置项说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `file` | `string` | 与 `url` 二选一 | — | 本地 Swagger 规范文件路径（JSON） |
| `url` | `string` | 与 `file` 二选一 | — | 远程规范地址，同时存在时优先使用 |
| `tags` | `string[]` | 与 `paths` 二选一 | `[]` | 按 tag 生成，每个 tag 一个文件；tag 名大小写不敏感 |
| `paths` | `string[]` | 与 `tags` 二选一 | `[]` | 按路径生成，先精确匹配再部分匹配；结果合并进同一文件 |
| `output` | `string` | 否 | — | 输出目录，不存在会自动创建 |
| `baseUrl` | `string` | 否 | `''` | 请求基础地址；省略时使用规范中的 `host` / `basePath` 拼接后的相对路径 |
| `format` | `'fetch' \| 'axios' \| 'curl'` | 否 | `'fetch'` | 代码输出格式 |
| `types` | `boolean` | 否 | `true` | 是否生成 `interface` 类型定义 |
| `comments` | `boolean` | 否 | `true` | 是否生成注释（summary、字段描述、枚举可用值、`@deprecated`） |

> `tags` 与 `paths` 同时配置时，`tags` 优先，`paths` 被忽略。

## 编程方式使用

```ts
import fs from 'node:fs';
import {
  parseSwaggerSpec,
  generateFetchCode,
  generateAxiosCode,
  generateCurlCode,
} from 'swagger-tools';

const spec = JSON.parse(fs.readFileSync('api.json', 'utf-8'));
const instance = parseSwaggerSpec(spec);

// 遍历所有接口
for (const api of instance.paths) {
  const code = generateFetchCode(api, instance, {
    baseUrl: 'https://api.example.com',
    types: true,
    comments: true,
  });
  console.log(code);
}

// 按 tag 取接口
const tag = instance.tags.find((t) => t.name === 'user-controller');
const api = tag?.childrens[0];
if (api) {
  generateAxiosCode(api, instance, { baseUrl: 'https://api.example.com' });
  generateCurlCode(api, { baseUrl: 'https://api.example.com' });
}
```

### 导出清单

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `parseSwaggerSpec(spec, groupName?)` | 函数 | 解析规范，返回 `ParsedInstance` |
| `generateFetchCode(api, instance?, options?)` | 函数 | 生成 `fetch` 调用 + 类型定义 |
| `generateAxiosCode(api, instance?, options?)` | 函数 | 生成 `axios` 调用 + 类型定义 |
| `generateCurlCode(api, options?)` | 函数 | 生成 `curl` 命令（不含类型定义） |
| `SwaggerSpec` / `Schema` / `OperationObject` … | 类型 | 原始规范相关类型 |
| `ParsedInstance` / `ParsedApiInfo` / `ParsedDefinition` / `ParsedParameter` … | 类型 | 解析后的模型类型 |

`GenerateOptions`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | `string` | `''` | 请求基础地址 |
| `types` | `boolean` | `true` | 是否生成类型定义 |
| `comments` | `boolean` | `true` | 是否生成注释 |
| `indentSize` | `number` | `2` | 缩进空格数 |

## 工作原理

```
Swagger/OpenAPI JSON
        │
        ▼
   parser.ts            解析 info / definitions / tags / paths / security
        │               产出统一的 ParsedInstance（OAS2 与 OAS3 归一化）
        ▼
  generator.ts          遍历 ParsedApiInfo，按参数位置（path/query/header/body/formData）
        │               组装函数签名、URL、headers、body、返回类型
        ▼
     cli.ts             按 tags / paths 分组，做类型去重后写入文件或打印
```

解析阶段的关键处理：

- **basePath 去重**：若超过 60% 的 `paths` 已带 `basePath` 前缀，则判定为已追加，避免重复拼接。
- **参数归一化**：OAS3 的 `requestBody` 会被转换成 `in: 'body'` 的参数；`x-example` / `default` 会被提取为示例值。
- **JSR-303 元数据**：`minimum` / `maximum` / `pattern` / `minLength` / `maxLength` 等约束会保留在 `validateInstance` 中，供后续生成校验逻辑。
- **循环引用保护**：`$ref` 递归解析时通过路径栈防止自引用导致的无限递归。

生成阶段的类型处理：

- `类型名«泛型参数»` 会被解析为泛型树，因此 `分页封装对象«学生成绩Vo»` → `PageResponse<XueShengChengJiVo>`。
- 泛型包装类只生成一次（如 `ApiResponse<T>`），并识别 `data` / `result` / `list` / `records` / `content` / `items` / `rows` / `dataList` 中的字段作为 `T` 载体。
- `List<T>` → `T[]`；嵌套模型名 `A.B` 取末段 `B`；纯中文名走拼音转写；重名时回退到完整名或追加数字后缀。
- 多个接口合并到同一文件时，重复的 `export interface` 会被自动跳过。

## 项目结构

```
swagger-tools/
├── src/                    # 库与 CLI 源码
│   ├── cli.ts              # CLI 入口：配置加载、命令分发、文件输出与类型去重
│   ├── parser.ts           # 规范解析器（OAS2 / OAS3 → ParsedInstance）
│   ├── generator.ts        # 代码生成器（fetch / axios / curl + TS 类型）
│   ├── types.ts            # 原始规范类型 + 解析后模型类型
│   ├── utils.ts            # 通用工具（$ref 解析、空值判断、JSR-303 等）
│   └── index.ts            # 库入口，统一导出
├── skills/                 # Agent Skill（开源标准布局，可直接分发）
│   ├── README.md           # Skill 索引与新增约定
│   └── swagger-request-codegen/
│       ├── SKILL.md        # 触发条件 + 6 步工作流
│       ├── README.md       # 面向人的使用说明
│       ├── tsconfig.json   # 类型检查配置
│       ├── scripts/gen.ts  # 零依赖生成器（Bun 直接运行）
│       └── references/     # 类型映射 / 框架模板 / 排错手册
├── swagger-tools.config.example.mjs # 配置样例
├── LICENSE
├── tsconfig.json
└── package.json
```

## Agent Skill

仓库内附带一个可独立分发的 Agent Skill：[`skills/swagger-request-codegen`](./skills/swagger-request-codegen/SKILL.md)。它把本工具的能力封装成「给一份 swagger.json，产出前端请求代码」的自动化流程——侦察接口清单 → 处理类型命名 → 生成 → 按项目封装落地 → 类型校验。

```bash
npm run skill:install   # 安装到 ~/.codebuddy/skills
npm run skill:package   # 打包为 dist-skills/swagger-request-codegen.zip
```

目录遵循开源 Agent Skill 布局（顶层 `skills/<name>/` + `SKILL.md` + `scripts/` + `references/`），与具体工具解耦，可复制到任意兼容 runtime 的 skills 目录。需要在本仓库中直接触发时，先执行 `npm run skill:install`。详见 [skills/README.md](./skills/README.md)。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 使用 `tsc` 编译到 `dist/`（含类型声明与 sourceMap） |
| `npm run cli -- <args>` | 不编译，直接用 Node 运行 `src/cli.ts` |
| `npm test` | 以 `api.json` 执行一次解析，用于快速自检 |
| `npm run skill:install` | 把 `skills/swagger-request-codegen` 安装到 `~/.codebuddy/skills` |
| `npm run skill:package` | 打包 Skill 为 `dist-skills/swagger-request-codegen.zip` |
| `npm run skill:typecheck` | 对 Skill 的 TypeScript 脚本做类型检查（`tsc --noEmit`） |

## 注意事项

- 生成的 `axios` 代码默认运行环境中已存在 `axios`，需要自行 `import axios from 'axios'`（或使用全局注入的实例）。
- 生成的 `fetch` 代码直接 `return response.json()`，未做业务状态码（如 `code !== 0`）判断，建议按项目规范二次封装。
- 中文模型名的英文转写依赖 `pinyin-pro`，其中常见返回封装类名（`ApiResponse` / `PageResponse` / `CommonResponse` 等）由内置映射表覆盖；其余名字为拼音直译，可读性有限。
- 解析只接受 **JSON** 格式规范，YAML 需先自行转换。

## License

ISC，详见 [LICENSE](./LICENSE)。
