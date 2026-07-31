# 卖家离线许可证工具

本目录只包含签发程序，不包含私钥。私钥必须生成并保存在项目目录、同步盘和买家交付包之外。
生成器使用 Node.js 内置 Ed25519，实现只有一份；PowerShell 文件只是便于 Windows 调用的包装器。

## 首次生成签名密钥

```powershell
.\create-signing-key.ps1 -KeyDirectory 'C:\安全位置\FribergLicenseSecrets'
```

目录中会出现：

- `private-license-key.pem`：只归卖家保存，绝不能发送；
- `public-license-key.pem`：用于构建买家扩展，可以公开。

如果文件已经存在，生成器会拒绝覆盖。请对私钥制作一份加密离线备份。

## 签发许可证

买家在商业扩展激活页点击“复制设备码”，把形如
`FRB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` 的设备码发给卖家。

```powershell
.\generate-license.ps1 `
  -PrivateKey 'C:\安全位置\FribergLicenseSecrets\private-license-key.pem' `
  -DeviceCode 'FRB-....' `
  -Days 7 `
  -LicenseId 'XY-20260730-0001' `
  -Out 'C:\安全位置\issued\XY-20260730-0001.txt'
```

许可证从生成时开始按自然时间计时。离线许可证不能远程撤销，也不能可靠按实际使用小时计费；
首批测试建议只签发 1 天、7 天或 30 天授权。
