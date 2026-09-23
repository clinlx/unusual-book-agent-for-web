# 模组列表与链接导入

构建不复制、生成或覆盖 `modules.json`，也不将列表嵌入 HTML。请手动将列表文件复制到 `dist/modules.json`，部署时与 `dist/index.html` 一起上传。页面启动后自动请求页面同目录的 `modules.json`，并在浏览器中解析、校验列表。之后可直接修改服务器上的 `modules.json`，刷新页面即可读取新列表，无需重新构建 HTML。空列表不显示“从列表选择”；文件缺失、加载或格式出错时提示仍可从链接或文件导入，不阻塞页面启动。

页面支持 `?url=ZIP下载链接`：访问后自动下载、导入并打开存档，无需再次点击。链接值必须使用 `encodeURIComponent` 编码，例如 `https://your-site.example/index.html?url=https%3A%2F%2Ffiles.example%2Fworld.zip`。生成分享地址可使用 `const share = new URL(pageUrl); share.searchParams.set('url', zipUrl);`，这样 ZIP 链接自身的 `?`、`&`、`+` 等字符也能正确传递。支持站内相对路径。每次访问此地址都会尝试导入一个新存档，失败会显示错误且不写入不完整存档。

## modules.json 格式

```json
[
  {
    "Name": "模组名称",
    "Introduction": "卡片上的简短介绍",
    "Text": "详情说明，支持换行。",
    "Link": "https://example.com/module.zip",
    "Cover": "./covers/module.jpg",
    "CoverFit": "auto",
    "Tags": [
      {"TagName": "悬疑", "Color": "#66ccff"}
    ]
  }
]
```

字段说明：

- `Name`：必填，模组名称。
- `Introduction`：可选，列表卡片上的简短介绍；缺省时按空字符串处理。
- `Text`：可选，详情页说明文字；缺省时按空字符串处理。
- `Link`：必填，模组 ZIP 的下载地址。仅用于下载，不在列表卡片和详情页中直接展示。
- `Cover`：可选，模组封面图片地址。可使用 `http://`、`https://` 或站内相对路径；为空或省略时不显示封面。封面会同时显示在模组列表卡片和详情页中。
- `CoverFit`：可选，控制封面在固定展示区域内的适配方式。支持 `auto`、`horizontal`、`vertical`、`stretch`；缺省或填写其他值时自动使用 `auto`。
- `Tags`：可选，标签数组；缺省时为空数组。每个标签需要 `TagName` 与 `Color`，其中颜色必须是六位十六进制格式，例如 `#66ccff`。

## 封面字段

`Cover` 与 `Link` 相互独立：`Cover` 只负责界面展示图片，`Link` 仍然负责下载模组存档。

`CoverFit` 的四种模式：

- `auto`：默认模式，按区域尺寸自动裁切并铺满封面。
- `horizontal`：优先按高度铺满，适合横向较宽的图片。
- `vertical`：优先按宽度铺满，适合纵向较高的图片。
- `stretch`：直接拉伸到展示区域大小，可能改变原始宽高比。

例如：

```json
{
  "Name": "雾港夜行",
  "Introduction": "一座被潮雾封锁的港城。",
  "Text": "调查失踪事件，并在天亮前找到离开的办法。",
  "Link": "/files/雾港夜行.zip",
  "Cover": "/covers/雾港夜行.png",
  "CoverFit": "vertical",
  "Tags": [
    {"TagName": "悬疑", "Color": "#667788"},
    {"TagName": "都市", "Color": "#8c6f55"}
  ]
}
```

封面地址与下载地址一样，只接受不含账号密码的 HTTP / HTTPS URL 或站内路径，不支持 `//example.com/image.png` 形式的协议相对地址。使用外站图片时，还需要确保浏览器能够直接加载该图片；页面会使用 `no-referrer` 方式请求封面。

## Link 与部署

标签颜色使用六位十六进制格式。列表文件本身是公开资源，因此不要在 `modules.json` 中存放密钥、登录凭据或其他敏感信息。

`Link` 支持绝对地址和相对地址：`/files/追书人.zip` 指向当前网站根目录下的文件；`./files/追书人.zip` 指向页面所在目录下的文件。中文路径也可使用百分号编码。构建会保留相对地址，浏览器在下载时按当前页面地址解析，同源下载不需要 CORS 许可。需要将 ZIP 部署到对应路径；列表配置不会自动复制或下载 ZIP。直接双击本地 HTML 时无法使用站内链接，请通过网站访问或选择“从文件导入”。

下载地址必须返回有效 ZIP，并允许浏览器跨域请求。支持重定向及不带 `.zip` 后缀的下载地址。当前“从列表选择”和 `?url=` 的网络下载入口会检查下载内容是否以 ZIP 签名开头，因此这里的 `Link` 应指向普通 ZIP；带 ZIP 数据的 PNG 复合存档目前适用于“从文件导入”。

程序会先尝试 HEAD 获取大小；失败或大小未知时继续 GET。已知大小或实际下载量超过 100 MiB 时拒绝导入。ZIP 在内存中解析，成功后保存解压后的存档，不会留下下载文件。失败不会写入不完整存档。
