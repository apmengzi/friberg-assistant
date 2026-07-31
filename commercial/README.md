# 弗一把助手 Pro 0.9.2 Paid Beta

商业版与 0.9.1 个人版共用求解器、646 人题库、反馈矩阵和 DOM 适配器，只增加
离线许可证门禁。当前构建不连接卡密服务器，也不需要买家安装 Node、Python、Docker
或启动本地服务。

## 离线授权模型

- Ed25519 私钥只由卖家保管，扩展只包含公钥；
- 扩展首次运行生成 128 位随机安装实例标识；
- 买家复制带校验位的设备码，卖家针对该设备码签发许可证；
- 许可证载荷包含产品、版本范围、设备摘要、生效时间、到期时间和功能；
- 扩展直接验证签名原始载荷，篡改载荷会使签名失效；
- 系统时间相对历史最大时间倒退超过 6 小时时暂停核心功能；
- 到期或检查失败时停止监听、求解、填入和提交。

离线许可证无法远程撤销，也不能彻底阻止修改扩展或恢复整套浏览器数据快照。当前目标是
降低普通复制和直接转发许可证的可用性，不宣称绝对防破解。建议只按自然时间签发
1 天、7 天或 30 天测试授权，不按实际使用小时计费。

原在线 Worker 保留在 `commercial/license-worker`，但不参与当前商业构建。

## 构建

```powershell
.\tools\package-commercial-extension.ps1 `
  -PublicKeyPath 'C:\项目外密钥目录\public-license-key.pem'

.\scripts\audit-commercial-zip.ps1
```

输出：

- `dist/friberg-assistant-commercial/`
- `dist/friberg-assistant-commercial.zip`
- `docs/COMMERCIAL_BUILD_AUDIT.md`

商业 ZIP 根目录直接包含 `manifest.json`，权限仅限 `storage` 和
`https://shnlfriberg.online/multi*`。

## 签发

参见：

- `seller-tools/license-generator/README.md`
- `docs/SELLER_LICENSE_GUIDE.md`
- `docs/BUYER_QUICK_START.md`

