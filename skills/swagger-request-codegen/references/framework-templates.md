# 目标项目适配模板

`scripts/gen.ts` 输出的是「零依赖纯函数 + interface」。落地到具体项目时，按下面模板改造。改造原则：保留生成的类型与路径，把请求实现换成项目既有封装。

## 1. 判断落地形态

先确认三件事，再决定改造方式：

1. 项目是否已有统一请求封装（`src/utils/request.ts`、`src/api/http.ts`、`axios.create(...)`）？
2. 服务端数据层用什么（React Query / SWR / Pinia / 自定义 store / 直接调用）？
3. 目录约定（`src/api/<模块>.ts`、`src/services/<模块>.ts`、`src/types/<模块>.d.ts`）？

有既有封装：**只保留 interface 与 URL/参数拼接逻辑**，请求部分改为调用封装。没有：使用原生 `fetch` 版本，或先用下面的 axios 实例模板建一层。

## 2. 原生 fetch（生成的默认形态）

```ts
export async function getStudentDetail(
  studentId: string,
  withParent?: boolean
): Promise<ApiResponse<StudentVo>> {
  const params = new URLSearchParams();
  if (withParent != null) params.append('withParent', String(withParent));
  const query = params.toString();

  const url = `${import.meta.env.VITE_API_BASE}/student/${studentId}/detail` + (query ? '?' + query : '');

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${getToken()}` },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
```

要点：把生成时的固定 `baseUrl` 换成环境变量；鉴权头统一在请求层注入。

## 3. axios 实例（推荐项目中转层）

先建实例，生成代码改为调用实例：

```ts
// src/api/http.ts
import axios from 'axios';

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE,
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => {
    const body = res.data as { code?: number; message?: string; data?: unknown };
    if (body && typeof body.code === 'number' && body.code !== 0) {
      throw new Error(body.message || '请求失败');
    }
    return res;
  },
  (err) => Promise.reject(err),
);
```

生成代码改为：

```ts
import { http } from './http';

export async function createOrder(data: CreateOrderReq): Promise<Order> {
  const res = await http.post<ApiResponse<Order>>('/orders', data);
  return res.data.data;
}
```

注意：`baseURL` 已在实例里，生成时应加 `--no-base-url`（或改后手工删掉前缀），否则会重复拼接。

## 4. React Query / SWR

```ts
// src/api/order.ts
import { useQuery, useMutation } from '@tanstack/react-query';
import { http } from './http';
import type { Order, PageResult, CreateOrderReq } from '@/types/order';
import { getOrders, postOrders } from '@/generated/order';

export function useOrders(page: number, size?: number, status?: string) {
  return useQuery({
    queryKey: ['orders', page, size, status],
    queryFn: () => getOrders(page, size, status),
  });
}

export function useCreateOrder() {
  return useMutation({
    mutationFn: (payload: CreateOrderReq) => postOrders(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}
```

Hook 只做薄封装，业务逻辑留在调用处；`queryKey` 必须包含全部查询参数。

## 5. Vue 3 Composition API / Pinia

```ts
// src/composables/useOrderList.ts
import { ref } from 'vue';
import { getOrders } from '@/generated/order';
import type { Order } from '@/generated/order';

export function useOrderList() {
  const list = ref<Order[]>([]);
  const loading = ref(false);
  const total = ref(0);

  async function load(page = 1, size = 20) {
    loading.value = true;
    try {
      const res = await getOrders(page, size);
      list.value = res.items ?? [];
      total.value = res.total ?? 0;
    } finally {
      loading.value = false;
    }
  }

  return { list, loading, total, load };
}
```

## 6. Next.js / Nuxt 服务端调用

服务端组件或 Server Action 中直接使用生成的 fetch 函数，并把 `baseUrl` 指向内部网关地址：

```ts
const baseUrl = process.env.API_INTERNAL_URL!;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const data = await listOrders(Number(searchParams.get('page') ?? 1));
  return Response.json(data);
}
```

浏览器端调用仍需走 Route Handler，避免把内部地址与密钥暴露给客户端。

## 7. uni-app / 小程序

`fetch` 不可用时，替换请求实现而非重写函数：

```ts
function request<T>(options: UniApp.RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    uni.request({
      ...options,
      success: (res) => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve(res.data as T)
        : reject(new Error(`HTTP ${res.statusCode}`)),
      fail: reject,
    });
  });
}
```

`URLSearchParams` 在小程序中不可用，改为手工拼接 `?key=value`。

## 8. 文件组织建议

| 场景 | 建议 |
| --- | --- |
| 接口数 < 20 | 单文件 `src/api/index.ts` |
| 按业务域划分 | `--tags` 生成 `src/api/<domain>.ts`，再统一 `export * from './user'` |
| 类型与请求分离 | 生成的 interface 抽到 `src/types/<domain>.ts`，请求文件 `import type` |
| 需要按接口粒度 | `--paths` 生成单个方法，追加到既有模块文件末尾 |

## 9. 收尾检查清单

- 删除无用类型、合并语义重复的 interface。
- 确认 `baseUrl` 只出现在一处（实例或函数内，不要重复）。
- 确认可选参数位置合法（必填在可选之前）。
- 确认响应解包层级与后端信封一致（`ApiResponse<T>` 是否要 `.data`）。
- 运行项目的类型检查与 lint（`tsc --noEmit`、`eslint`）并修复报错。
