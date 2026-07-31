# 卖家许可证指南

## 密钥

当前正式密钥应保存在项目目录之外。私钥绝不能发送给买家、上传网盘、放进 ZIP 或粘贴到
聊天中。公钥可以公开，并已嵌入商业扩展。

首次创建密钥：

```powershell
.\seller-tools\license-generator\create-signing-key.ps1 `
  -KeyDirectory 'C:\项目外安全目录\FribergLicenseSecrets'
```

生成器拒绝覆盖已有密钥，也拒绝在项目目录内部创建私钥。请另做一份加密离线备份。

## 可签发时长

许可证按签发后的自然时间连续计时，不是累计使用时长。常用卡种对应参数如下：

| 卡种 | 生成参数 |
| --- | --- |
| 5 小时卡 | `-Hours 5` |
| 12 小时卡 | `-Hours 12` |
| 1 天卡 | `-Days 1` |
| 3 天卡 | `-Days 3` |
| 7 天卡 | `-Days 7` |
| 30 天卡 | `-Days 30` |

每次只使用 `-Hours` 或 `-Days` 中的一种，并为每笔订单设置唯一的 `-LicenseId`。

## 签发许可证

```powershell
.\seller-tools\license-generator\generate-license.ps1 `
  -PrivateKey 'C:\项目外安全目录\FribergLicenseSecrets\private-license-key.pem' `
  -DeviceCode '买家发送的 FRB-…' `
  -Days 7 `
  -LicenseId 'XY-订单号-0001' `
  -Out 'C:\项目外安全目录\issued\XY-订单号-0001.txt'
```

其他卡种只需按上表替换 `-Days 7`。例如 5 小时卡使用 `-Hours 5` 并删除
`-Days 7`。

生成结果中的许可证编号、设备码、签发/到期时间和 SHA-256 可用于交付记录。只把文件中
以 `FRIBERG1.` 开头的完整许可证发送给对应买家。

## 换机

离线许可证无法在旧设备上远程撤销。换机前应核对订单和旧许可证编号，再针对新设备码
重新签发；是否补时由卖家人工决定。
