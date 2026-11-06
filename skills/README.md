# Skills

本目录按 Agent Skill 开源布局组织：每个子目录即一个独立可安装的 skill，目录名与 `SKILL.md` 中的 `name` 保持一致。

```
skills/
└── <skill-name>/
    ├── SKILL.md        # 必需：frontmatter(name, description) + 工作流说明
    ├── README.md       # 可选：面向人的使用说明
    ├── scripts/        # 可选：确定性脚本，由 Agent 直接执行
    ├── references/     # 可选：按需加载的规则文档
    └── assets/         # 可选：输出用到的模板/资源
```

## 可用 Skill

| Skill | 说明 | 依赖 |
| --- | --- | --- |
| [`swagger-request-codegen`](./swagger-request-codegen/SKILL.md) | 由 Swagger/OpenAPI JSON 生成前端请求代码（fetch / axios / cURL）与 TypeScript 类型 | Bun ≥ 1.0；`pinyin-pro` 可选 |

## 安装

```bash
# 安装到用户级 skills 目录（对所有项目生效）
npm run skill:install

# 或手动复制
cp -R skills/swagger-request-codegen ~/.codebuddy/skills/
```

仓库本身不包含任何 runtime 专属目录，使用前先安装到对应的 skills 目录（如 `~/.codebuddy/skills`）。

## 打包分发

```bash
npm run skill:package   # 产出 dist-skills/swagger-request-codegen.zip
```

## 新增 Skill 约定

1. 目录名使用小写短横线（`kebab-case`），与 frontmatter 的 `name` 完全一致。
2. `description` 用第三人称描述「做什么 + 何时触发」，长度控制在 1024 字符内。
3. 详细规则放 `references/`，`SKILL.md` 只保留触发条件、工作流与资源索引。
4. 可重复执行、需要确定性的逻辑写成 `scripts/` 下的脚本，避免每次重新生成代码。
5. 不提交打包产物与本地缓存，见根目录 `.gitignore`。
