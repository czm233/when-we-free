# When We Free

多人聚会时间共识日历。纯前端实现，可直接部署到 GitHub Pages。

## 功能

- 添加参与者并设置名称、颜色。
- 选择当前身份后，点击日历日期即可切换“这一天有空”。
- 每个日期会显示所有有空参与者的颜色条。
- 当所有参与者都标注同一天有空时，该日期自动变为绿色聚会候选日。
- 数据保存在浏览器本地，也可以通过“分享”生成带状态的链接。

## 本地运行

```bash
npm install
npm run dev
```

本地预览端口固定为 `http://127.0.0.1:10060/when-we-free/`。

## 部署

推送到 `main` 后，GitHub Actions 会执行构建并部署到 GitHub Pages。

```bash
npm run build
```
