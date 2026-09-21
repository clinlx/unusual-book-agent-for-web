# 模组列表与链接导入

构建不复制、生成或覆盖 `modules.json`，也不将列表嵌入 HTML。请手动将列表文件复制到 `dist/modules.json`，部署时与 `dist/index.html` 一起上传。页面启动后自动请求页面同目录的 `modules.json`，并在浏览器中解析、校验列表。之后可直接修改服务器上的 `modules.json`，刷新页面即可读取新列表，无需重新构建 HTML。空列表不显示“从列表选择”；文件缺失、加载或格式出错时提示仍可从链接或文件导入，不阻塞页面启动。

页面支持 `?url=ZIP下载链接`：访问后自动下载、导入并打开存档，无需再次点击。链接值必须使用 `encodeURIComponent` 编码，例如 `https://your-site.example/index.html?url=https%3A%2F%2Ffiles.example%2Fworld.zip`。生成分享地址可使用 `const share = new URL(pageUrl); share.searchParams.set('url', zipUrl);`，这样 ZIP 链接自身的 `?`、`&`、`+` 等字符也能正确传递。支持站内相对路径。每次访问此地址都会尝试导入一个新存档，失败会显示错误且不写入不完整存档。

```json
[
  {
    "Name": "模组名称",
    "Introduction": "卡片上的简短介绍",
    "Text": "详情说明，支持换行。",
    "Link": "https://example.com/module.zip",
    "Tags": [{"TagName": "悬疑", "Color": "#66ccff"}]
  }
]
```

标签颜色使用六位十六进制格式。Link 仅用于下载，不在列表和详情中展示；列表文件是公开资源。下载地址必须返回有效 ZIP，并允许浏览器跨域请求。支持重定向及不带 `.zip` 后缀的下载地址。

Link 也支持相对地址：`/files/追书人.zip` 指向当前网站根目录下的文件；`./files/追书人.zip` 指向页面所在目录下的文件。中文路径也可使用百分号编码。构建会保留相对地址，浏览器在下载时按当前页面地址解析，同源下载不需要 CORS 许可。需要将 ZIP 部署到对应路径；列表配置不会自动复制或下载 ZIP。直接双击本地 HTML 时无法使用站内链接，请通过网站访问或选择“从文件导入”。

先尝试 HEAD 获取大小；失败或大小未知时继续 GET。已知大小或实际下载量超过 100 MiB 时拒绝导入。ZIP 在内存中解析，成功后保存解压后的存档，不会留下下载文件。失败不会写入不完整存档。
