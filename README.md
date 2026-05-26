# When We Free

多人聚会时间共识日历。前端部署在 GitHub Pages，可选接入 Supabase 做实时房间。

## 功能

- 添加参与者并设置名称、颜色。
- 选择当前身份后，点击日历日期即可切换“这一天有空”。
- 每个日期会显示所有有空参与者的颜色条。
- 当所有参与者都标注同一天有空时，该日期自动变为绿色聚会候选日。
- 未配置 Supabase 时使用本地模式，可复制快照链接。
- 配置 Supabase 后，房间创建者可以添加参与者，并为每个人复制专属编辑链接。
- 参与者通过自己的专属链接进入房间后，只能修改自己的名称、颜色和可用日期。
- 房间创建者可以解散房间；解散后房间链接和参与者专属链接都会失效。
- 普通房间链接只有查看权限；创建者链接包含 `adminKey`，参与者链接包含 `participantKey`。
- 浏览器会按房间记住上次选择的当前身份，重新打开同一房间时默认回到该身份；参与者专属链接会锁定到对应身份。

## 本地运行

```bash
npm install
npm run dev
```

本地预览端口固定为 `http://127.0.0.1:10060/when-we-free/`。

## Supabase 实时模式

1. 在 Supabase 新建一个项目。
2. 打开 SQL Editor，执行 [supabase/schema.sql](supabase/schema.sql)。
3. 复制项目的 Project URL 和 publishable/anon public key。
4. 本地创建 `.env.local`：

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

5. 重新运行 `npm run dev`。

部署到 GitHub Pages 时，在仓库 `Settings -> Secrets and variables -> Actions -> Variables` 添加：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

anon key 会被打包到浏览器端，这是 Supabase 的公开前端 key。不要使用 service role key。

数据库表开启了 RLS，浏览器端不直接读写表；前端只调用 `get_when_we_free_room` 和
`save_when_we_free_room` 两个 RPC，并通过实时广播同步同一房间链接内的在线变更。
`roomKey` 负责读取房间，`adminKey` 负责管理参与者和解散房间，`participantKey` 由服务端识别对应参与者，并只允许更新这个参与者自己的数据。

## 部署

推送到 `main` 后，GitHub Actions 会执行构建并部署到 GitHub Pages。

```bash
npm run build
```
