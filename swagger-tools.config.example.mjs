// ============================================================
// swagger-tools 配置文件
// 文件名: swagger-tools.config.mjs
// 说明: 放在项目根目录，运行 swagger-tools 即可自动加载
// 支持 JS 原生语法（注释、变量、环境变量、条件判断等）
// ============================================================

export default {
  // ---- Swagger 规范来源（二选一） ----

  /** 本地文件路径（相对于此配置文件） */
  file: 'api.json',

  /** 远程 URL（如 Swagger Hub / 内网文档地址）。与 file 二选一，同时指定时 url 优先 */
  // url: 'https://petstore.swagger.io/v2/swagger.json',

  // ---- 生成目标（二选一） ----

  /** 按标签 (tags) 生成各分组下所有接口的代码（数组，每个 tag 生成一个文件） */
  tags: ['drawing-class-controller'],

  /** 按接口路径生成（支持部分路径匹配，数组，每个路径生成一个文件）。与 tags 二选一，同时指定时 tags 优先 */
  // paths: ['/drawing/class/queryStudentRead'],

  // ---- 可选 ----

  /** 输出目录。按 tag 生成时写入 <dir>/<tag>.ts */
  output: './output',

  /** 基础 URL。为空则从 swagger 文档的 host/basePath 推断 */
  baseUrl: 'https://api.example.com',

  /** 输出格式: 'curl' | 'fetch' | 'axios'。默认 'fetch' */
  format: 'fetch',

  /** 是否生成 TypeScript 类型定义。默认 true */
  types: true,

  /** 是否生成注释。默认 true */
  comments: true,
};
