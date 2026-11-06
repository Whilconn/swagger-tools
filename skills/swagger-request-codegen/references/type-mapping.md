# 解析与类型映射规则

`scripts/gen.ts` 的确定性行为规则。生成结果不符合预期时，先在此处对照原因，再决定是调整规范、使用 `--rename`，还是手工改写输出。

## 1. 规范来源与版本判定

| 判定 | 条件 | 模型来源 | 响应体来源 |
| --- | --- | --- | --- |
| OAS 2.0 | 无 `openapi` 字段，或 `swagger` 非 `3.x` | `definitions` | `responses[code].schema` |
| OAS 3.x | `openapi: "3.x"` | `components.schemas` | `responses[code].content[*].schema` |

- `$ref` 前缀：OAS2 为 `#/definitions/X`，OAS3 为 `#/components/schemas/X`；裸模型名（如 `StudentVo.SubVo`）也可识别。
- 输入必须是 JSON。YAML 需先转换：`npx js-yaml spec.yaml > spec.json`。
- 基础地址优先级：`--base-url` > OAS3 `servers[0].url` > OAS2 `schemes[0] + host + basePath`。`/` 结尾会被去除，最终拼接为 `baseUrl + path`。

## 2. 参数 → 函数签名

| 参数位置 | 函数参数 | 调用侧处理 |
| --- | --- | --- |
| `path` | 必填，类型取自 `schema` | URL 模板 `${name}` |
| `query` | 按 `required` 决定是否 `?` | `new URLSearchParams()` 拼接（fetch）/ `params` 对象（axios） |
| `header` | 按 `required` 决定是否 `?`，可选时 `?? ''` | `headers` 对象 |
| `body`（OAS2 `in: body` / OAS3 `requestBody`） | `data` | `JSON.stringify(data)`（fetch）/ `data`（axios） |
| `formData` / `multipart/form-data` | `data: FormData` | 直接作为 body，不设置 `Content-Type` |
| `cookie` | 忽略 | 需在请求拦截器中统一处理 |

其他规则：

- 必填参数统一排在可选参数之前（避免 TS1016）。
- 参数名从 `class-id` 转为 `classId`，非法字符转为 `_`，数字开头加 `p` 前缀。
- OAS3 `requestBody` 只取第一个 JSON 类型 content；`multipart/form-data` 转为 `FormData`。
- 参数 `$ref`（`#/components/parameters/X`、`#/parameters/X`）会自动解引用。

## 3. 响应 → 返回类型

选取顺序：`200` → 第一个 `2xx` → `default`。

| 规范写法 | 生成返回类型 |
| --- | --- |
| `schema: {$ref}` | 对应 interface |
| `schema: {type: array, items: {$ref}}` | `T[]` |
| `schema` 为内联 object | 内联字面量类型 `{ a: string; b?: number }` |
| 只有 `type: string/number/boolean` | `string` / `number` / `boolean` |
| `204` / `205` 或无 `responses` | `Promise<void>`，函数体 `return;` |
| `200` 但未声明 schema | `unknown`，函数体 `return response.json()` |

## 4. 字段 → TS 类型

| schema | TS |
| --- | --- |
| `integer` / `number`（含 `int32`、`int64`、`double`） | `number` |
| `boolean` | `boolean` |
| `string`（含 `date`、`date-time`、`uuid` format） | `string` |
| `array` | `T[]`，联合类型自动加括号 `(A \| B)[]` |
| `object` + `additionalProperties: {schema}` | `Record<string, T>` |
| `object` + `additionalProperties: true` | `Record<string, unknown>` |
| `enum` | 字面量联合 `"A" \| "B"` |
| `oneOf` / `anyOf` | 联合类型 |
| `allOf` | 属性合并为一个 interface，`required` 取并集 |
| `nullable: true` | 不额外加 `\| null`，按需手工补充 |
| 未声明的 object | `Record<string, unknown>` |

可选性只看 `required` 数组，不看 `default`。

## 5. 泛型与中文命名

中文/Java 风格泛型 `包装类«实参»` 的处理：

| 原始定义 | 生成 |
| --- | --- |
| `分页返回封装对象«学生阅读记录Vo»` | `PageResponse<学生阅读记录Vo>` |
| `接口统一返回封装对象«学生成绩Vo»` | `ApiResponse<学生成绩Vo>` |
| `List«学生等级Vo»` | `学生等级Vo[]` |
| `Map«string,UserVo»` | `Record<string, UserVo>` |
| `A.B`（嵌套模型） | `B` |

泛型包装 interface 只生成一次，并把数据载体字段替换为 `T`：优先取类型等于泛型实参的字段，其次取 `data` / `result` / `list` / `records` / `rows` / `items` / `content` / `dataList` / `body`；该字段为数组时写 `T[]`。

命名转换优先级：

1. `--rename` 映射（`{"学生成绩Vo": "StudentScoreVo"}`）——**推荐做法**：由 Agent 根据中文语义给出准确英文名。
2. 内置映射表（`接口统一返回封装对象`→`ApiResponse`、`分页封装对象`→`PageResponse`、`返回结果`→`Result` 等）。
3. 姓名结尾的点号模型取末段。
4. 含中文时：可解析到 `pinyin-pro`（工程 `node_modules` 中存在）则转拼音 PascalCase（`学生等级Vo` → `XueShengDengJiVo`），否则保留中文标识符（TS 合法，但可读性差，建议配 `--rename`）。
5. 非法字符剔除；重名时回退完整名，仍冲突则追加数字后缀。

## 6. 类型定义登记与去重

- 类型按需生成：只输出被选中接口实际引用到的模型，包括请求体及其嵌套引用。
- 同名类型只输出一次；多个 tag 分别输出到不同文件时各自独立，不做跨文件引用。
- 自引用（树形结构）不会无限递归，遇到已登记的类型直接复用。
- 循环引用的模型会退化为 `Record<string, unknown>` 占位而不是报错。

## 7. 已知边界

- 不生成接口鉴权代码（token 注入交给目标项目的请求封装或拦截器）。
- 不处理 `x-java-*`、`readOnly`/`writeOnly` 的读写分离，`readOnly` 字段仍会出现在 interface 中。
- 不做业务状态码判断（如 `code !== 0`），返回值即 HTTP body。
- axios 输出假定运行环境已有 `axios`，需要在文件顶部自行 `import axios from 'axios'`。
- 文件名与类型名可能重复（如 `/user/list` 与 `/user/{id}` 都派生 `getUserList`），生成后需检查重名。
