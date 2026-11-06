# 常见问题排查

## 输入相关

**脚本报「文件不存在」或「远程返回的内容不是 JSON」**

规范必须是 JSON。YAML 需先转换，且转换后校验结构：

```bash
npx js-yaml openapi.yaml > openapi.json && node -e "console.log(Object.keys(require('./openapi.json')))"
```

远程地址需要鉴权时，先下载到本地再处理（脚本不带认证能力）：

```bash
curl -H "Authorization: Bearer $TOKEN" "https://host/v3/api-docs" -o spec.json
```

**规范很大（数 MB / 上千接口）**

不要一次性全量生成。先摸清结构，再按 tag 分批：

```bash
bun scripts/gen.ts --file spec.json --list          # 只看 tag 与接口清单
bun scripts/gen.ts --file spec.json --summary       # 只看元信息与模型数量
bun scripts/gen.ts --file spec.json --tags order --out src/api
```

## 匹配相关

**「未匹配到任何接口」**

脚本会打印可用 tag 列表。注意：`--tags` 大小写不敏感但需完全匹配 tag 名；`--paths` 支持部分匹配（如 `/user` 命中 `/user/list`、`/user/{id}`）。若仍无结果，用 `--search user` 做全文模糊匹配。

**接口没有 `tags`**

归入 `default`，用 `--tags default` 或直接省略筛选条件。

## 类型相关

**类型名是中文**

当前工作目录可解析到 `pinyin-pro` 时会转拼音，否则保留中文（TS 合法）。想要可读的英文名，最稳妥的做法是提供映射：

```bash
cat > rename.json <<'EOF'
{ "学生成绩Vo": "StudentScoreVo", "学生等级Vo": "StudentLevelVo", "分页封装对象": "PageResponse" }
EOF
bun scripts/gen.ts --file spec.json --tags student --rename rename.json --out src/api
```

映射键必须与 `definitions` / `components.schemas` 中的原始 key 完全一致（泛型不用带 «»，只映射基础名）。

**类型名重复或出现 `Xxx2`**

同名但语义不同的模型被压缩到同一标识符。用 `--rename` 显式区分，或分批生成到不同文件。

**生成 `Record<string, unknown>` 而不是具体类型**

- 该字段没有 `properties` 也没有 `$ref`；
- 或存在循环引用，被安全降级。

补充规范的 `properties` 后重跑即可。

**`unknown` 返回类型**

成功响应缺少 `schema`。补全 `500` 之外的 `2xx` 响应 schema，或在使用处显式断言。

## 生成代码相关

**`error TS1016: A required parameter cannot follow an optional parameter`**

脚本已按必填优先排序；若手工调整过签名顺序，需保持必填在前。

**`Cannot find name 'axios'`**

axios 输出不含 import，按项目约定补：

```ts
import axios from 'axios';           // 或
import { http } from './http';       // 推荐，改用项目实例
```

**URL 里出现重复的 basePath / 前缀**

生成的 `url` 已包含 `--base-url`。接入 axios 实例的 `baseURL` 时，要么生成时 `--base-url ''`，要么删除实例的 `baseURL`。

**上传接口传的是 JSON**

`multipart/form-data` 会生成 `data: FormData`。若规范里写成了 `application/json`，需要在规范侧修正 `requestBody.content` 的类型。

**`204` 接口仍 `return response.json()`**

脚本对 `204`/`205` 生成 `Promise<void>`。若不是这个组合，说明成功响应里声明了 schema，按需手工删除返回语句。

**删除接口生成 `Promise<void>`，但后端其实返回 JSON**

规范漏写了响应体，补 schema 后重跑。

## 落地相关

**生成文件与既有 `src/api/*.ts` 冲突**

不要整文件覆盖。按 `--paths` 生成单个接口函数，追加到既有文件中；类型以「先查重再合并」的方式并入 `types/`。

**需要在 SSR / Node 环境运行**

原生 `fetch` 在 Node 18+ 可用；`URLSearchParams` 也内建。小程序等缺少这两者的环境，参考 `framework-templates.md` 换成平台请求 API。

**浏览器直接调用出现 CORS**

生成的 `baseUrl` 指向前端代理或 BFF 地址，而不是后端裸域名。
