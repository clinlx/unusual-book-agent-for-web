# 异闻手记与世界设计者

使用 AI 游玩故事、构建世界的浏览器应用。

- **异闻手记**（`dist/index.html`）：导入世界，开启单人跑团与故事冒险。
- **世界设计者**（`dist/designer.html`）：与 AI 讨论设定、编辑世界文件、校验格式，并将世界导入异闻手记游玩。

两页可互相切换，需分别配置模型服务。数据保存在当前浏览器中，不会自动跨设备同步，请及时下载备份。

## 构建与使用

需要 Node.js 22 或更高版本：

```sh
npm ci
npm run build
```

Windows 也可双击 `build.bat`。构建后直接打开 `dist/index.html` 或 `dist/designer.html`；两个页面请放在同一目录。部署网站时上传这两个 HTML 和 `dist/robots.txt`。
