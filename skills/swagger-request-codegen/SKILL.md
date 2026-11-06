---
name: swagger-request-codegen
description: This skill should be used when the user provides a Swagger/OpenAPI JSON file or URL and wants frontend request code generated from it — for example "根据这个 swagger.json 生成接口代码", "生成 api.ts", "把接口文档转成 axios 请求", "生成接口的 TypeScript 类型". It parses OAS 2.0/3.0 specs, filters by tag or path, and emits fetch/axios/cURL functions with TypeScript interfaces.
license: ISC
---

# Swagger/OpenAPI → 前端请求代码

把接口规范转换为可直接落地的前端请求代码。核心能力由 `scripts/gen.ts` 提供：零依赖 TypeScript 脚本，默认用 Bun 直接运行（无需构建），同时兼容 Node ≥ 22.18；解析 OAS 2.0 / 3.0，按 tag 或路径筛选，输出 `fetch` / `axios` / `cURL` 三种形态以及配套的 TypeScript `interface`。

## 适用场景

- 用户给出 `swagger.json`、`openapi.json`、`api-docs` 地址或直接粘贴规范片段，要求生成接口代码、请求方法、类型定义。
- 需要把后端接口文档迁移为前端的 `api/*.ts`、`services/*.ts`、DTO 类型。
- 需要为已有模块补充某个 tag / 某几个路径的调用函数。

不适用：YAML 直读（先转 JSON）、需要生成后端代码、规范内容缺失需要靠猜测补全字段。

## 工作流程

### 第 0 步：确认运行环境

脚本是 TypeScript，直接用 Bun 运行（无需安装依赖或编译）。先确认可用：

```bash
bun --version   # 期望 ≥ 1.0
```

不可用时提示用户安装（`curl -fsSL https://bun.sh/install | bash` 或 `npm i -g bun`）。若环境确实无法安装 Bun，而 Node ≥ 22.18 可用，可改用 `node scripts/gen.ts ...` 运行（脚本只用 `node:` 内置模块与标准 `fetch`，两种运行时行为一致）；不要因为缺少运行时改为手写代码。

### 第 1 步：确认输入与目标

明确三件事，缺失时按默认值处理并在结果中说明：

| 项 | 说明 | 默认 |
| --- | --- | --- |
| 规范位置 | 本地 `--file` 或远程 `--url` | 必填 |
| 代码形态 | 项目已有 axios 封装则用 `axios`，否则 `fetch` | `fetch` |
| 落地位置 | 目标目录 / 文件名 | 打印到终端，由用户确认后再写文件 |

若规范是 YAML、或远程地址需要鉴权，先转换为本地 JSON 文件（见 `references/troubleshooting.md`）。

### 第 2 步：侦察规范结构

**不要**把整份规范读入上下文。先跑清单，拿到 tag、接口路径、模型数量：

```bash
bun scripts/gen.ts --file <spec.json> --list
bun scripts/gen.ts --file <spec.json> --summary
bun scripts/gen.ts --file <spec.json> --list --json
```

根据输出向用户确认要生成的 tag / 路径范围。接口数量多时按 tag 分批。

### 第 3 步：处理类型命名

规范中的模型名可能是中文（`学生成绩Vo`）、含泛型符号（`分页封装对象«学生成绩Vo»`）或带点号（`A.B`）。

- 中文名会被转为拼音（工程内可解析 `pinyin-pro` 时）或保留中文标识符。若目标项目使用英文 DTO，**主动生成 rename 映射**再生成：

```bash
cat > /tmp/rename.json <<'EOF'
{ "学生成绩Vo": "StudentScoreVo", "分页封装对象": "PageResponse" }
EOF
```

映射键使用规范中的原始模型名（泛型映射基础名，不带 `«»`）。

- 命名规则、泛型展开、响应类型选取的完整规则见 `references/type-mapping.md`。生成结果异常时先查该文件再动手改。

### 第 4 步：生成代码

```bash
# 按 tag 分文件（每个 tag 一个文件）
bun scripts/gen.ts --file spec.json --tags order,user --out ./src/api --base-url https://api.example.com

# 按路径生成（合并到同一文件）
bun scripts/gen.ts --file spec.json --paths /order/list,/order/create --out ./src/api/order.ts

# 远程规范 + axios
bun scripts/gen.ts --url https://host/v3/api-docs --format axios --tags order --out ./src/api

# 只看某个接口
bun scripts/gen.ts --file spec.json --search createOrder
```

参数要点：

- `--out` 传目录时按 tag 生成 `<tag>.ts`（`curl` 格式为 `.sh`），传 `*.ts` 时作为单文件。
- `--base-url` 省略时自动取 OAS3 `servers[0]` 或 OAS2 `schemes + host + basePath`；接入 axios 实例时加 `--no-base-url` 生成相对路径，避免重复前缀。
- `--no-types` 只出纯调用函数；`--no-comments` 去掉 JSDoc 与字段注释。

### 第 5 步：落地适配

生成结果是「零依赖纯函数 + interface」，不是最终形态。按目标项目改写请求实现，同时保留 URL 拼接与类型：

1. 定位项目既有请求封装（`src/utils/request.ts`、`axios.create`、`uni.request` 包装等）。
2. 把 `fetch(...)` / `axios.request(...)` 替换为项目封装调用。
3. 按目录约定拆分：interface 可抽到 `src/types/<domain>.ts`，方法放 `src/api/<domain>.ts`。
4. 补鉴权头、业务状态码判断、错误提示——这些不应出现在生成代码里，而应统一在请求层完成。
5. 不要整文件覆盖用户已有的 `api.ts`：优先按路径生成单个函数后追加。

各框架（React Query、Pinia、Next.js Route Handler、uni-app）的改造模板见 `references/framework-templates.md`。

### 第 6 步：校验

```bash
npx tsc --noEmit          # 或项目自带的 typecheck 脚本
npx eslint <生成文件>
```

必须确认：无 TS1016（必填参数在可选之后）、无未定义标识符（axios / FormData）、无重复 interface、`baseUrl` 只出现一次。发现问题时优先修正生成参数或改名，而不是逐个手改。

## 输出约定

- 每个接口上方注释 `// [METHOD] /path - summary`，便于与文档比对。
- 类型定义按需生成，只包含被选接口引用到的模型，同名只出现一次。
- 返回类型取 `200` → 首个 `2xx` → `default`；`204`/`205` 生成 `Promise<void>`。
- 不做业务错误处理，不做鉴权注入，不编造规范中不存在的字段。

## 参考文件

| 文件 | 用途 |
| --- | --- |
| `references/type-mapping.md` | 参数、响应、字段类型、泛型与中文命名的完整映射规则，以及已知边界 |
| `references/framework-templates.md` | axios 实例、React Query、Pinia、Next.js、uni-app 的落地模板与组织建议 |
| `references/troubleshooting.md` | 匹配失败、类型异常、URL 重复、上传接口、编码等问题的排查路径 |

## 禁止事项

- 不臆造接口、字段或枚举值；规范中没有的内容一律不生成。
- 不把规范的 `host` 硬编码进业务代码，改用环境变量或请求实例的 `baseURL`。
- 不在生成结果中保留测试用的假数据、`console.log` 或示例 token。
