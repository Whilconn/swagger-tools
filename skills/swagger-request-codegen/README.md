# swagger-request-codegen

把 Swagger / OpenAPI 规范变成前端可直接使用的请求代码。

- 输入：`swagger.json`、`openapi.json`、`/v3/api-docs` 地址
- 输出：`fetch` / `axios` / `cURL` 调用函数 + TypeScript `interface`
- 能力：OAS 2.0 / 3.0、按 tag 或路径筛选、泛型包装还原、中文模型名转写、类型自动去重

## 安装

```bash
# 从仓库根目录安装（对所有项目生效）
npm run skill:install

# 或在任意位置手动复制
cp -R skills/swagger-request-codegen ~/.codebuddy/skills/
```

安装后在 CodeBuddy 中提到「根据这个 swagger.json 生成接口代码」「生成 api.ts」「接口文档转 axios 请求」等诉求即可触发。

## 直接使用脚本

不依赖 Agent，也可以把它当成命令行工具（Bun 直接执行 `.ts`，无需构建）：

```bash
S=~/.codebuddy/skills/swagger-request-codegen/scripts/gen.ts

# 1. 侦察：看有哪些 tag、接口、模型
bun $S --file spec.json --list
bun $S --file spec.json --summary

# 2. 生成：按 tag 分文件
bun $S --file spec.json --tags order,user --out ./src/api --format axios

# 3. 生成：按路径合并到单文件
bun $S --file spec.json --paths /order/list,/order/create --out ./src/api/order.ts

# 4. 远程规范 + 相对路径（交给 axios 实例的 baseURL）
bun $S --url https://host/v3/api-docs --tags order --no-base-url --out ./src/api

# 5. 中文模型名映射为英文
bun $S --file spec.json --tags student --rename rename.json --out ./src/api
```

`rename.json` 示例：

```json
{ "学生成绩Vo": "StudentScoreVo", "分页封装对象": "PageResponse" }
```

完整参数见 `bun $S --help`。

## 目录结构

```
swagger-request-codegen/
├── SKILL.md                      # 触发条件与 6 步工作流
├── README.md                     # 本文件
├── tsconfig.json                 # 可选：类型检查配置
├── scripts/
│   └── gen.ts                    # 零依赖生成器（Bun 运行）
└── references/
    ├── type-mapping.md           # 参数/响应/类型/泛型/命名映射规则
    ├── framework-templates.md    # axios、React Query、Pinia、Next.js、uni-app 落地模板
    └── troubleshooting.md        # 常见问题排查
```

## 环境要求

- Bun ≥ 1.0（直接运行 TypeScript，无需编译；脚本只用 `node:` 内置模块与全局 `fetch`）
- 可选：`pinyin-pro`（用于把纯中文模型名转为拼音标识符；缺失时保留中文标识符，TypeScript 仍然合法）
- 可选：Node.js ≥ 22.18 也能运行（内置类型剥离），仅作兜底，未做兼容承诺

## 行为约定

- 只生成规范中真实存在的字段与接口，不补全、不猜测。
- 返回类型取 `200` → 首个 `2xx` → `default`；`204/205` 或无响应体生成 `Promise<void>`。
- 必填参数排在可选参数之前；同名类型只输出一次。
- 鉴权、业务状态码判断、错误提示留给目标项目的请求层，不写进生成结果。

## License

ISC，见仓库根目录 [LICENSE](../../LICENSE)。
